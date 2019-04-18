import * as vscode from 'vscode';
import * as assert from 'assert';
import { showFile } from '../helper';
import { CompletionItem, MarkupContent } from 'vscode-languageclient';

export interface ExpectedCompletionItem extends CompletionItem {
  documentationStart?: string;
}

export async function testCompletion(
  docUri: vscode.Uri,
  position: vscode.Position,
  expectedItems: (string | ExpectedCompletionItem)[]
) {
  await showFile(docUri);

  const result = (await vscode.commands.executeCommand(
    'vscode.executeCompletionItemProvider',
    docUri,
    position
  )) as vscode.CompletionList;

  expectedItems.forEach(ei => {
    if (typeof ei === 'string') {
      assert.ok(
        result.items.some(i => {
          return i.label === ei;
        })
      );
    } else {
      const match = result.items.find(i => i.label === ei.label);
      if (!match) {
        assert.fail(`Can't find matching item for ${JSON.stringify(ei, null, 2)}`);
        return;
      }

      assert.ok(match.label, ei.label);
      assert.ok(match.kind, ei.kind as any);

      if (ei.documentation) {
        if (typeof match.documentation === 'string') {
          assert.equal(match.documentation, ei.documentation);
        } else {
          if (ei.documentation && (ei.documentation as MarkupContent).value && match.documentation) {
            assert.equal(
              (match.documentation as vscode.MarkdownString).value.replace(/\r/g, ''),
              (ei.documentation as MarkupContent).value.replace(/\r/g, '\n')
            );
          }
        }
      }

      if (ei.documentationStart) {
        if (typeof match.documentation === 'string') {
          assert.ok(match.documentation.startsWith(ei.documentationStart));
        } else {
          assert.ok((match.documentation as vscode.MarkdownString).value.startsWith(ei.documentationStart));
        }
      }
    }
  });
}
