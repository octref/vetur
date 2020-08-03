import * as vscode from 'vscode';
import * as fs from 'fs';
import { performance } from 'perf_hooks';

export async function showFile(docUri: vscode.Uri) {
  const doc = await vscode.workspace.openTextDocument(docUri);
  return await vscode.window.showTextDocument(doc);
}

export async function setEditorContent(editor: vscode.TextEditor, content: string): Promise<boolean> {
  const doc = editor.document;
  const all = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
  return editor.edit(eb => eb.replace(all, content));
}

export function readFileAsync(path: string) {
  return new Promise((resolve, reject) => {
    fs.readFile(path, 'utf-8', (err, data) => {
      if (err) {
        reject(err);
      }

      resolve(data);
    });
  });
}

export function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Retry to get diagnostics until length > 0 or timeout
export async function getDiagnosticsAndTimeout(docUri: vscode.Uri, timeout = 5000) {
  const startTime = performance.now();

  let result = vscode.languages.getDiagnostics(docUri);

  while (result.length <= 0 && startTime + timeout > performance.now()) {
    result = vscode.languages.getDiagnostics(docUri);
    await sleep(100);
  }

  return result;
}
