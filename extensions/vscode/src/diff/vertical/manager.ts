import { DiffLine } from "core";
import { ConfigHandler } from "core/config/ConfigHandler";
import { streamDiffLines } from "core/edit/streamDiffLines";
import { pruneLinesFromBottom, pruneLinesFromTop } from "core/llm/countTokens";
import { getMarkdownLanguageTagForFile } from "core/util";
import * as vscode from "vscode";

import EditDecorationManager from "../../quickEdit/EditDecorationManager";
import { VsCodeWebviewProtocol } from "../../webviewProtocol";

import { VerticalDiffHandler, VerticalDiffHandlerOptions } from "./handler";

export interface VerticalDiffCodeLens {
  start: number;
  numRed: number;
  numGreen: number;
}

export class VerticalDiffManager {
  public refreshCodeLens: () => void = () => {};

  private fileUriToHandler: Map<string, VerticalDiffHandler> = new Map();

  fileUriToCodeLens: Map<string, VerticalDiffCodeLens[]> = new Map();

  private userChangeListener: vscode.Disposable | undefined;

  logDiffs: DiffLine[] | undefined;

  constructor(
    private readonly configHandler: ConfigHandler,
    private readonly webviewProtocol: VsCodeWebviewProtocol,
    private readonly editDecorationManager: EditDecorationManager,
  ) {
    this.userChangeListener = undefined;
  }

  createVerticalDiffHandler(
    fileUri: vscode.Uri,
    startLine: number,
    endLine: number,
    options: VerticalDiffHandlerOptions,
  ) {
    const uriString = fileUri.toString();
    if (this.fileUriToHandler.has(uriString)) {
      this.fileUriToHandler.get(uriString)?.clear(false);
      this.fileUriToHandler.delete(uriString);
    }
    const editor = vscode.window.activeTextEditor; // TODO
    if (editor && editor.document.uri.toString() === uriString) {
      const handler = new VerticalDiffHandler(
        startLine,
        endLine,
        editor,
        this.fileUriToCodeLens,
        this.clearForFileUri.bind(this),
        this.refreshCodeLens,
        options,
      );
      this.fileUriToHandler.set(uriString, handler);
      return handler;
    } else {
      return undefined;
    }
  }

  getHandlerForUri(uri: vscode.Uri) {
    return this.fileUriToHandler.get(uri.toString());
  }

  // Creates a listener for document changes by user.
  private enableDocumentChangeListener(): vscode.Disposable | undefined {
    if (this.userChangeListener) {
      //Only create one listener per file
      return;
    }

    this.userChangeListener = vscode.workspace.onDidChangeTextDocument(
      (event) => {
        // Check if there is an active handler for the affected file
        const fileUri = event.document.uri;
        const handler = this.getHandlerForUri(fileUri);
        if (handler) {
          // If there is an active diff for that file, handle the document change
          this.handleDocumentChange(event, handler);
        }
      },
    );
  }

  // Listener for user doc changes is disabled during updates to the text document by continue
  public disableDocumentChangeListener() {
    if (this.userChangeListener) {
      this.userChangeListener.dispose();
      this.userChangeListener = undefined;
    }
  }

  private handleDocumentChange(
    event: vscode.TextDocumentChangeEvent,
    handler: VerticalDiffHandler,
  ) {
    // Loop through each change in the event
    event.contentChanges.forEach((change) => {
      // Calculate the number of lines added or removed
      const linesAdded = change.text.split("\n").length - 1;
      const linesDeleted = change.range.end.line - change.range.start.line;
      const lineDelta = linesAdded - linesDeleted;

      // Update the diff handler with the new line delta
      handler.updateLineDelta(
        event.document.uri.toString(),
        change.range.start.line,
        lineDelta,
      );
    });
  }

  clearForFileUri(fileUri: vscode.Uri | undefined, accept: boolean) {
    if (!fileUri) {
      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor) {
        return;
      }
      fileUri = activeEditor.document.uri;
    }

    const handler = this.fileUriToHandler.get(fileUri.toString());
    if (handler) {
      handler.clear(accept);
      this.fileUriToHandler.delete(fileUri.toString());
    }

    this.disableDocumentChangeListener();

    vscode.commands.executeCommand("setContext", "continue.diffVisible", false);
  }

  async acceptRejectVerticalDiffBlock(
    accept: boolean,
    fileUri?: vscode.Uri,
    index?: number,
  ) {
    if (!fileUri) {
      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor) {
        return;
      }
      fileUri = activeEditor.document.uri;
    }

    if (typeof index === "undefined") {
      index = 0;
    }

    const blocks = this.fileUriToCodeLens.get(fileUri.toString());
    const block = blocks?.[index];
    if (!blocks || !block) {
      return;
    }

    const handler = this.getHandlerForUri(fileUri);
    if (!handler) {
      return;
    }

    // Disable listening to file changes while continue makes changes
    this.disableDocumentChangeListener();

    // CodeLens object removed from editorToVerticalDiffCodeLens here
    await handler.acceptRejectBlock(
      accept,
      block.start,
      block.numGreen,
      block.numRed,
    );

    if (blocks.length === 1) {
      this.clearForFileUri(fileUri, true);
    } else {
      // Re-enable listener for user changes to file
      this.enableDocumentChangeListener();
    }
  }

  async streamDiffLines(
    diffStream: AsyncGenerator<DiffLine>,
    instant: boolean,
    streamId: string,
  ) {
    vscode.commands.executeCommand("setContext", "continue.diffVisible", true);

    // Get the current editor uri/range
    let editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const fileUri = editor.document.uri;
    const startLine = 0;
    const endLine = editor.document.lineCount - 1;

    // Check for existing handlers in the same file the new one will be created in
    const existingHandler = this.getHandlerForUri(fileUri);
    if (existingHandler) {
      existingHandler.clear(false);
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });

    // Create new handler with determined start/end
    const diffHandler = this.createVerticalDiffHandler(
      fileUri,
      startLine,
      endLine,
      {
        instant,
        onStatusUpdate: (status, numDiffs) =>
          this.webviewProtocol.request("updateApplyState", {
            streamId,
            status,
            numDiffs,
          }),
      },
    );

    if (!diffHandler) {
      console.warn("Issue occured while creating new vertical diff handler");
      return;
    }

    if (editor.selection) {
      // Unselect the range
      editor.selection = new vscode.Selection(
        editor.selection.active,
        editor.selection.active,
      );
    }

    vscode.commands.executeCommand(
      "setContext",
      "continue.streamingDiff",
      true,
    );

    try {
      this.logDiffs = await diffHandler.run(diffStream);

      // enable a listener for user edits to file while diff is open
      this.enableDocumentChangeListener();
    } catch (e) {
      this.disableDocumentChangeListener();
      vscode.window.showErrorMessage(`Error streaming diff: ${e}`);
    } finally {
      vscode.commands.executeCommand(
        "setContext",
        "continue.streamingDiff",
        false,
      );
    }
  }

  async streamEdit(
    input: string,
    modelTitle: string | undefined,
    streamId?: string,
    onlyOneInsertion?: boolean,
    quickEdit?: string,
    range?: vscode.Range,
  ) {
    vscode.commands.executeCommand("setContext", "continue.diffVisible", true);

    let editor = vscode.window.activeTextEditor;

    if (!editor) {
      return;
    }

    const filepath = editor.document.uri.toString();

    let startLine, endLine: number;

    if (range) {
      startLine = range.start.line;
      endLine = range.end.line;
    } else {
      startLine = editor.selection.start.line;
      endLine = editor.selection.end.line;
    }

    // Check for existing handlers in the same file the new one will be created in
    const existingHandler = this.getHandlerForUri(filepath);

    if (existingHandler) {
      if (quickEdit) {
        // Previous diff was a quickEdit
        // Check if user has highlighted a range
        let rangeBool =
          startLine != endLine ||
          editor.selection.start.character != editor.selection.end.character;

        // Check if the range is different from the previous range
        let newRangeBool =
          startLine != existingHandler.range.start.line ||
          endLine != existingHandler.range.end.line;

        if (!rangeBool || !newRangeBool) {
          // User did not highlight a new range -> use start/end from the previous quickEdit
          startLine = existingHandler.range.start.line;
          endLine = existingHandler.range.end.line;
        }
      }

      // Clear the previous handler
      // This allows the user to edit above the changed area,
      // but extra delta was added for each line generated by Continue
      // Before adding this back, we need to distinguish between human and Continue
      // let effectiveLineDelta =
      //   existingHandler.getLineDeltaBeforeLine(startLine);
      // startLine += effectiveLineDelta;
      // endLine += effectiveLineDelta;

      existingHandler.clear(false);
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });

    // Create new handler with determined start/end
    const diffHandler = this.createVerticalDiffHandler(
      filepath,
      startLine,
      endLine,
      {
        input,
        onStatusUpdate: (status, numDiffs) =>
          streamId &&
          this.webviewProtocol.request("updateApplyState", {
            streamId,
            status,
            numDiffs,
          }),
      },
    );

    if (!diffHandler) {
      console.warn("Issue occured while creating new vertical diff handler");
      return;
    }

    let selectedRange = diffHandler.range;

    // Only if the selection is empty, use exact prefix/suffix instead of by line
    if (selectedRange.isEmpty) {
      selectedRange = new vscode.Range(
        editor.selection.start.with(undefined, 0),
        editor.selection.end.with(undefined, Number.MAX_SAFE_INTEGER),
      );
    }

    const llm = await this.configHandler.llmFromTitle(modelTitle);
    const rangeContent = editor.document.getText(selectedRange);
    const prefix = pruneLinesFromTop(
      editor.document.getText(
        new vscode.Range(new vscode.Position(0, 0), selectedRange.start),
      ),
      llm.contextLength / 4,
      llm.model,
    );
    const suffix = pruneLinesFromBottom(
      editor.document.getText(
        new vscode.Range(
          selectedRange.end,
          new vscode.Position(editor.document.lineCount, 0),
        ),
      ),
      llm.contextLength / 4,
      llm.model,
    );

    if (editor.selection) {
      // Unselect the range
      editor.selection = new vscode.Selection(
        editor.selection.active,
        editor.selection.active,
      );
    }

    vscode.commands.executeCommand(
      "setContext",
      "continue.streamingDiff",
      true,
    );

    this.editDecorationManager.clear();

    try {
      this.logDiffs = await diffHandler.run(
        streamDiffLines(
          prefix,
          rangeContent,
          suffix,
          llm,
          input,
          getMarkdownLanguageTagForFile(filepath),
          onlyOneInsertion,
        ),
      );

      // enable a listener for user edits to file while diff is open
      this.enableDocumentChangeListener();
    } catch (e) {
      this.disableDocumentChangeListener();
      vscode.window.showErrorMessage(`Error streaming diff: ${e}`);
    } finally {
      vscode.commands.executeCommand(
        "setContext",
        "continue.streamingDiff",
        false,
      );
    }
  }
}
