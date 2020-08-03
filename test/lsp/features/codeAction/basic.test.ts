import * as vscode from 'vscode';
import * as assert from 'assert';
import { showFile, getDiagnosticsAndTimeout } from '../../helper';
import { getDocUri, sameLineRange } from '../../util';
import { CodeAction } from 'vscode-languageclient';

describe('Should do codeAction', () => {
  const docUri = getDocUri('codeAction/Basic.vue');

  it('finds codeAction for unused import', async () => {
    const codeActions: CodeAction[] = [{ title: `Remove unused declaration for: 'lodash'` }];
    await testCodeAction(docUri, sameLineRange(5, 6, 6), codeActions);
  });

  it('finds codeAction for unused variables', async () => {
    const codeActions: CodeAction[] = [{ title: `Remove unused declaration for: 'foo'` }];
    await testCodeAction(docUri, sameLineRange(7, 6, 6), codeActions);
  });
});

async function testCodeAction(docUri: vscode.Uri, range: vscode.Range, expectedActions: CodeAction[]) {
  await showFile(docUri);

  await getDiagnosticsAndTimeout(docUri);

  const result = (await vscode.commands.executeCommand(
    'vscode.executeCodeActionProvider',
    docUri,
    range
  )) as vscode.CodeAction[];

  expectedActions.forEach(eAction => {
    const matchingAction = result.find(rAction => rAction.title === eAction.title);
    assert.ok(
      matchingAction,
      `Cannot find matching codeAction with title '${eAction.title}'\n` +
        `Seen codeActions are:\n${JSON.stringify(result, null, 2)}`
    );
  });
}
