import { LanguageModelCache, getLanguageModelCache } from '../../embeddedSupport/languageModelCache';
import {
  SymbolInformation,
  SymbolKind,
  Location,
  SignatureHelp,
  SignatureInformation,
  ParameterInformation,
  Command,
  Definition,
  TextEdit,
  TextDocument,
  Diagnostic,
  DiagnosticSeverity,
  Range,
  CompletionItemKind,
  MarkedString,
  DocumentHighlightKind,
  FormattingOptions,
  MarkupContent,
  DiagnosticTag
} from 'vscode-languageserver-types';
import { LanguageMode } from '../../embeddedSupport/languageModes';
import { VueDocumentRegions, LanguageRange } from '../../embeddedSupport/embeddedSupport';
import { getServiceHost } from './serviceHost';
import { prettierify, prettierEslintify } from '../../utils/prettier';
import { getFileFsPath, getFilePath } from '../../utils/paths';

import Uri from 'vscode-uri';
import * as ts from 'typescript';
import * as _ from 'lodash';

import { nullMode, NULL_SIGNATURE } from '../nullMode';
import { VLSFormatConfig } from '../../config';
import { VueInfoService } from '../../services/vueInfoService';
import { getComponentInfo } from './componentInfo';
import { DocumentService, VueDocumentInfo } from '../../services/documentService';
import { ExternalDocumentService } from '../../services/externalDocumentService';
import { DependencyService, T_TypeScript, State } from '../../services/dependencyService';
import { RefactorAction } from '../../types';

// Todo: After upgrading to LS server 4.0, use CompletionContext for filtering trigger chars
// https://microsoft.github.io/language-server-protocol/specification#completion-request-leftwards_arrow_with_hook
const NON_SCRIPT_TRIGGERS = ['<', '/', '*', ':'];

export async function getJavascriptMode(
  documentService: DocumentService,
  externalDocumentService: ExternalDocumentService,
  workspacePath: string | undefined,
  vueInfoService?: VueInfoService,
  dependencyService?: DependencyService
): Promise<LanguageMode> {
  if (!workspacePath) {
    return {
      ...nullMode
    };
  }
  const jsDocuments = getLanguageModelCache(10, 60, document => {
    let documentInfo = documentService.getDocumentInfo(document) as VueDocumentInfo;
    if (!documentInfo) {
      documentInfo = new VueDocumentInfo(document);
    }
    const vueDocument = documentInfo.regions;
    return vueDocument.getSingleTypeDocumentInfo('script');
  });

  const firstScriptRegion = getLanguageModelCache(10, 60, document => {
    let documentInfo = documentService.getDocumentInfo(document) as VueDocumentInfo;
    if (!documentInfo) {
      documentInfo = new VueDocumentInfo(document);
    }
    const vueDocument = documentInfo.regions;
    const scriptRegions = vueDocument.getLanguageRangesOfType('script');
    return scriptRegions.length > 0 ? scriptRegions[0] : undefined;
  });

  let tsModule: T_TypeScript = ts;
  if (dependencyService) {
    const tsDependency = dependencyService.getDependency('typescript');
    if (tsDependency && tsDependency.state === State.Loaded) {
      tsModule = tsDependency.module;
    }
  }

  const serviceHost = getServiceHost(tsModule, workspacePath, jsDocuments, externalDocumentService);
  const { updateCurrentTextDocument } = serviceHost;
  let config: any = {};
  let supportedCodeFixCodes: Set<number>;

  return {
    getId() {
      return 'javascript';
    },
    configure(c: any) {
      config = c;
    },
    updateFileInfo(doc) {
      if (!vueInfoService) {
        return;
      }

      const { service } = updateCurrentTextDocument(doc);
      const fileFsPath = getFileFsPath(doc.uri);
      const info = getComponentInfo(tsModule, service, fileFsPath, config);
      if (info) {
        vueInfoService.updateInfo(doc, info);
      }
    },

    doValidation(doc): Diagnostic[] {
      const templateDiags = getTemplateDiagnostics();
      const scriptDiags = getScriptDiagnostics();
      return [...templateDiags, ...scriptDiags];

      function getTemplateDiagnostics(): Diagnostic[] {
        const enabledTemplateValidation = config.vetur.experimental.templateTypeCheck;
        if (!enabledTemplateValidation) {
          return [];
        }

        // Add suffix to process this doc as vue template.
        const templateDoc = new VueDocumentInfo(
          TextDocument.create(doc.uri + '.template', doc.languageId, doc.version, doc.getText())
        );

        const { templateService } = updateCurrentTextDocument(templateDoc);
        if (!languageServiceIncludesFile(templateService, templateDoc.uri)) {
          return [];
        }

        const templateFileFsPath = getFileFsPath(templateDoc.uri);
        // We don't need syntactic diagnostics because
        // compiled template is always valid JavaScript syntax.
        const rawTemplateDiagnostics = templateService.getSemanticDiagnostics(templateFileFsPath);

        return rawTemplateDiagnostics.map(diag => {
          // syntactic/semantic diagnostic always has start and length
          // so we can safely cast diag to TextSpan
          return {
            range: convertRange(templateDoc, diag as ts.TextSpan),
            severity: DiagnosticSeverity.Error,
            message: ts.flattenDiagnosticMessageText(diag.messageText, '\n'),
            code: diag.code,
            source: 'Vetur'
          };
        });
      }

      function getScriptDiagnostics(): Diagnostic[] {
        const { scriptDoc, service } = updateCurrentTextDocument(doc);
        if (!languageServiceIncludesFile(service, doc.uri)) {
          return [];
        }

        const fileFsPath = getFileFsPath(doc.uri);
        const rawScriptDiagnostics = [
          ...service.getSyntacticDiagnostics(fileFsPath),
          ...service.getSemanticDiagnostics(fileFsPath)
        ];

        return rawScriptDiagnostics.map(diag => {
          const tags: DiagnosticTag[] = [];

          if (diag.reportsUnnecessary) {
            tags.push(DiagnosticTag.Unnecessary);
          }

          // syntactic/semantic diagnostic always has start and length
          // so we can safely cast diag to TextSpan
          return <Diagnostic>{
            range: convertRange(scriptDoc.document, diag as ts.TextSpan),
            severity: DiagnosticSeverity.Error,
            message: tsModule.flattenDiagnosticMessageText(diag.messageText, '\n'),
            tags,
            code: diag.code,
            source: 'Vetur'
          };
        });
      }
    },
    doComplete(document, position) {
      const { scriptDoc, service } = updateCurrentTextDocument(document);
      if (!languageServiceIncludesFile(service, document.uri)) {
        return { isIncomplete: false, items: [] };
      }

      const fileFsPath = getFileFsPath(document.uri);
      const offset = scriptDoc.document.offsetAt(position);
      const triggerChar = document.getText()[offset - 1];
      if (NON_SCRIPT_TRIGGERS.includes(triggerChar)) {
        return { isIncomplete: false, items: [] };
      }
      const completions = service.getCompletionsAtPosition(fileFsPath, offset, {
        includeCompletionsWithInsertText: true,
        includeCompletionsForModuleExports: _.get(config, ['vetur', 'completion', 'autoImport'])
      });
      if (!completions) {
        return { isIncomplete: false, items: [] };
      }
      const entries = completions.entries.filter(entry => entry.name !== '__vueEditorBridge');
      return {
        isIncomplete: false,
        items: entries.map((entry, index) => {
          const range = entry.replacementSpan && convertRange(scriptDoc.document, entry.replacementSpan);
          return {
            uri: document.uri,
            position,
            label: entry.name,
            sortText: entry.sortText + index,
            kind: convertKind(entry.kind),
            textEdit: range && TextEdit.replace(range, entry.name),
            data: {
              // data used for resolving item details (see 'doResolve')
              languageId: scriptDoc.languageId,
              uri: document.uri,
              offset,
              source: entry.source
            }
          };
        })
      };
    },
    doResolve(document, item) {
      const { service } = updateCurrentTextDocument(document);
      if (!languageServiceIncludesFile(service, document.uri)) {
        return item;
      }

      const fileFsPath = getFileFsPath(document.uri);
      const details = service.getCompletionEntryDetails(
        fileFsPath,
        item.data.offset,
        item.label,
        getFormatCodeSettings(config),
        item.data.source,
        {
          importModuleSpecifierEnding: 'minimal',
          importModuleSpecifierPreference: 'relative',
          includeCompletionsWithInsertText: true
        }
      );
      if (details) {
        item.detail = tsModule.displayPartsToString(details.displayParts);
        const documentation: MarkupContent = {
          kind: 'markdown',
          value: tsModule.displayPartsToString(details.documentation)
        };
        if (details.codeActions && config.vetur.completion.autoImport) {
          const textEdits = convertCodeAction(document, details.codeActions, firstScriptRegion);
          item.additionalTextEdits = textEdits;

          details.codeActions.forEach(action => {
            if (action.description) {
              documentation.value += '\n' + action.description;
            }
          });
        }
        item.documentation = documentation;
        delete item.data;
      }
      return item;
    },
    doHover(doc, position) {
      const { scriptDoc, service } = updateCurrentTextDocument(doc);
      if (!languageServiceIncludesFile(service, doc.uri)) {
        return { contents: [] };
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const info = service.getQuickInfoAtPosition(fileFsPath, scriptDoc.document.offsetAt(position));
      if (info) {
        const display = tsModule.displayPartsToString(info.displayParts);
        const doc = tsModule.displayPartsToString(info.documentation);
        const markedContents: MarkedString[] = [{ language: 'ts', value: display }];
        if (doc) {
          markedContents.unshift(doc, '\n');
        }
        return {
          range: convertRange(scriptDoc.document, info.textSpan),
          contents: markedContents
        };
      }
      return { contents: [] };
    },
    doSignatureHelp(doc, position) {
      const { scriptDoc, service } = updateCurrentTextDocument(doc);
      if (!languageServiceIncludesFile(service, doc.uri)) {
        return NULL_SIGNATURE;
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const signHelp = service.getSignatureHelpItems(fileFsPath, scriptDoc.document.offsetAt(position), undefined);
      if (!signHelp) {
        return NULL_SIGNATURE;
      }
      const ret: SignatureHelp = {
        activeSignature: signHelp.selectedItemIndex,
        activeParameter: signHelp.argumentIndex,
        signatures: []
      };
      signHelp.items.forEach(item => {
        const signature: SignatureInformation = {
          label: '',
          documentation: undefined,
          parameters: []
        };

        signature.label += tsModule.displayPartsToString(item.prefixDisplayParts);
        item.parameters.forEach((p, i, a) => {
          const label = tsModule.displayPartsToString(p.displayParts);
          const parameter: ParameterInformation = {
            label,
            documentation: tsModule.displayPartsToString(p.documentation)
          };
          signature.label += label;
          signature.parameters!.push(parameter);
          if (i < a.length - 1) {
            signature.label += tsModule.displayPartsToString(item.separatorDisplayParts);
          }
        });
        signature.label += tsModule.displayPartsToString(item.suffixDisplayParts);
        ret.signatures.push(signature);
      });
      return ret;
    },
    findDocumentHighlight(doc, position) {
      const { scriptDoc, service } = updateCurrentTextDocument(doc);
      if (!languageServiceIncludesFile(service, doc.uri)) {
        return [];
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const occurrences = service.getOccurrencesAtPosition(fileFsPath, scriptDoc.document.offsetAt(position));
      if (occurrences) {
        return occurrences.map(entry => {
          return {
            range: convertRange(scriptDoc.document, entry.textSpan),
            kind: entry.isWriteAccess ? DocumentHighlightKind.Write : DocumentHighlightKind.Text
          };
        });
      }
      return [];
    },
    findDocumentSymbols(doc) {
      const { scriptDoc, service } = updateCurrentTextDocument(doc);
      if (!languageServiceIncludesFile(service, doc.uri)) {
        return [];
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const items = service.getNavigationBarItems(fileFsPath);
      if (!items) {
        return [];
      }
      const result: SymbolInformation[] = [];
      const existing: { [k: string]: boolean } = {};
      const collectSymbols = (item: ts.NavigationBarItem, containerLabel?: string) => {
        const sig = item.text + item.kind + item.spans[0].start;
        if (item.kind !== 'script' && !existing[sig]) {
          const symbol: SymbolInformation = {
            name: item.text,
            kind: convertSymbolKind(item.kind),
            location: {
              uri: doc.uri,
              range: convertRange(scriptDoc.document, item.spans[0])
            },
            containerName: containerLabel
          };
          existing[sig] = true;
          result.push(symbol);
          containerLabel = item.text;
        }

        if (item.childItems && item.childItems.length > 0) {
          for (const child of item.childItems) {
            collectSymbols(child, containerLabel);
          }
        }
      };

      items.forEach(item => collectSymbols(item));
      return result;
    },
    findDefinition(doc, position) {
      const { scriptDoc, service } = updateCurrentTextDocument(doc);
      if (!languageServiceIncludesFile(service, doc.uri)) {
        return [];
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const definitions = service.getDefinitionAtPosition(fileFsPath, scriptDoc.document.offsetAt(position));
      if (!definitions) {
        return [];
      }

      const definitionResults: Definition = [];
      const program = service.getProgram();
      if (!program) {
        return [];
      }
      definitions.forEach(d => {
        const definitionTargetDoc = getSourceDoc(d.fileName, program);
        definitionResults.push({
          uri: Uri.file(d.fileName).toString(),
          range: convertRange(definitionTargetDoc, d.textSpan)
        });
      });
      return definitionResults;
    },
    findReferences(doc, position) {
      const { scriptDoc, service } = updateCurrentTextDocument(doc);
      if (!languageServiceIncludesFile(service, doc.uri)) {
        return [];
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const references = service.getReferencesAtPosition(fileFsPath, scriptDoc.document.offsetAt(position));
      if (!references) {
        return [];
      }

      const referenceResults: Location[] = [];
      const program = service.getProgram();
      if (!program) {
        return [];
      }
      references.forEach(r => {
        const referenceTargetDoc = getSourceDoc(r.fileName, program);
        if (referenceTargetDoc) {
          referenceResults.push({
            uri: Uri.file(r.fileName).toString(),
            range: convertRange(referenceTargetDoc, r.textSpan)
          });
        }
      });
      return referenceResults;
    },
    getCodeActions(doc, range, _formatParams, context) {
      const { scriptDoc, service } = updateCurrentTextDocument(doc);
      const fileName = getFileFsPath(scriptDoc.uri);
      const start = scriptDoc.document.offsetAt(range.start);
      const end = scriptDoc.document.offsetAt(range.end);
      if (!supportedCodeFixCodes) {
        supportedCodeFixCodes = new Set(
          ts
            .getSupportedCodeFixes()
            .map(Number)
            .filter(x => !isNaN(x))
        );
      }
      const fixableDiagnosticCodes = context.diagnostics.map(d => +d.code!).filter(c => supportedCodeFixCodes.has(c));
      if (!fixableDiagnosticCodes) {
        return [];
      }

      const formatSettings: ts.FormatCodeSettings = getFormatCodeSettings(config);

      const result: Command[] = [];
      const fixes = service.getCodeFixesAtPosition(
        fileName,
        start,
        end,
        fixableDiagnosticCodes,
        formatSettings,
        /*preferences*/ {}
      );
      collectQuickFixCommands(fixes, service, result);

      const textRange = { pos: start, end };
      const refactorings = service.getApplicableRefactors(fileName, textRange, /*preferences*/ {});
      collectRefactoringCommands(refactorings, fileName, formatSettings, textRange, result);

      return result;
    },
    getRefactorEdits(doc, args) {
      const { service } = updateCurrentTextDocument(doc);
      const response = service.getEditsForRefactor(
        args.fileName,
        args.formatOptions,
        args.textRange,
        args.refactorName,
        args.actionName,
        args.preferences
      );
      if (!response) {
        // TODO: What happens when there's no response?
        return createApplyCodeActionCommand('', {});
      }
      const uriMapping = createUriMappingForEdits(response.edits, service);
      return createApplyCodeActionCommand('', uriMapping);
    },
    format(doc, range, formatParams) {
      const { scriptDoc, service } = updateCurrentTextDocument(doc);

      const defaultFormatter =
        scriptDoc.languageId === 'javascript'
          ? config.vetur.format.defaultFormatter.js
          : config.vetur.format.defaultFormatter.ts;

      if (defaultFormatter === 'none') {
        return [];
      }

      const parser = scriptDoc.languageId === 'javascript' ? 'babylon' : 'typescript';
      const needInitialIndent = config.vetur.format.scriptInitialIndent;
      const vlsFormatConfig: VLSFormatConfig = config.vetur.format;

      if (defaultFormatter === 'prettier' || defaultFormatter === 'prettier-eslint') {
        const code = doc.getText(range);
        const filePath = getFileFsPath(scriptDoc.uri);

        return defaultFormatter === 'prettier'
          ? prettierify(code, filePath, range, vlsFormatConfig, parser, needInitialIndent)
          : prettierEslintify(code, filePath, range, vlsFormatConfig, parser, needInitialIndent);
      } else {
        const initialIndentLevel = needInitialIndent ? 1 : 0;
        const formatSettings: ts.FormatCodeSettings =
          scriptDoc.languageId === 'javascript' ? config.javascript.format : config.typescript.format;
        const convertedFormatSettings = convertOptions(
          formatSettings,
          {
            tabSize: vlsFormatConfig.options.tabSize,
            insertSpaces: !vlsFormatConfig.options.useTabs
          },
          initialIndentLevel
        );

        const fileFsPath = getFileFsPath(doc.uri);
        const start = scriptDoc.document.offsetAt(range.start);
        const end = scriptDoc.document.offsetAt(range.end);
        const edits = service.getFormattingEditsForRange(fileFsPath, start, end, convertedFormatSettings);

        if (!edits) {
          return [];
        }
        const result = [];
        for (const edit of edits) {
          if (edit.span.start >= start && edit.span.start + edit.span.length <= end) {
            result.push({
              range: convertRange(scriptDoc.document, edit.span),
              newText: edit.newText
            });
          }
        }
        return result;
      }
    },
    onDocumentRemoved(document: TextDocument) {
      jsDocuments.onDocumentRemoved(document);
    },
    onDocumentChanged(filePath: string) {
      serviceHost.updateExternalDocument(filePath);
    },
    dispose() {
      serviceHost.dispose();
      jsDocuments.dispose();
    }
  };
}

function collectRefactoringCommands(
  refactorings: ts.ApplicableRefactorInfo[],
  fileName: string,
  formatSettings: any,
  textRange: { pos: number; end: number },
  result: Command[]
) {
  const actions: RefactorAction[] = [];
  for (const refactoring of refactorings) {
    const refactorName = refactoring.name;
    if (refactoring.inlineable) {
      actions.push({
        fileName,
        formatOptions: formatSettings,
        textRange,
        refactorName,
        actionName: refactorName,
        preferences: {},
        description: refactoring.description
      });
    } else {
      actions.push(
        ...refactoring.actions.map(action => ({
          fileName,
          formatOptions: formatSettings,
          textRange,
          refactorName,
          actionName: action.name,
          preferences: {},
          description: action.description
        }))
      );
    }
  }
  for (const action of actions) {
    result.push({
      command: 'vetur.chooseTypeScriptRefactoring',
      title: action.description,
      arguments: [action]
    });
  }
}

function collectQuickFixCommands(
  fixes: ReadonlyArray<ts.CodeFixAction>,
  service: ts.LanguageService,
  result: Command[]
) {
  for (const fix of fixes) {
    const uriTextEditMapping = createUriMappingForEdits(fix.changes, service);
    result.push(createApplyCodeActionCommand(fix.description, uriTextEditMapping));
  }
}

function createApplyCodeActionCommand(title: string, uriTextEditMapping: Record<string, TextEdit[]>): Command {
  return {
    title,
    command: 'vetur.applyWorkspaceEdits',
    arguments: [
      {
        changes: uriTextEditMapping
      }
    ]
  };
}

function createUriMappingForEdits(changes: ts.FileTextChanges[], service: ts.LanguageService) {
  const program = service.getProgram()!;
  const result: Record<string, TextEdit[]> = {};
  for (const { fileName, textChanges } of changes) {
    const targetDoc = getSourceDoc(fileName, program);
    const edits = textChanges.map(({ newText, span }) => ({
      newText,
      range: convertRange(targetDoc, span)
    }));
    const uri = Uri.file(fileName).toString();
    if (result[uri]) {
      result[uri].push(...edits);
    } else {
      result[uri] = edits;
    }
  }
  return result;
}

function getSourceDoc(fileName: string, program: ts.Program): TextDocument {
  const sourceFile = program.getSourceFile(fileName)!;
  return TextDocument.create(fileName, 'vue', 0, sourceFile.getFullText());
}

function languageServiceIncludesFile(ls: ts.LanguageService, documentUri: string): boolean {
  const filePaths = ls.getProgram()!.getRootFileNames();
  const filePath = getFilePath(documentUri);
  return filePaths.includes(filePath);
}

function convertRange(document: TextDocument, span: ts.TextSpan): Range {
  const startPosition = document.positionAt(span.start);
  const endPosition = document.positionAt(span.start + span.length);
  return Range.create(startPosition, endPosition);
}

function convertKind(kind: ts.ScriptElementKind): CompletionItemKind {
  switch (kind) {
    case 'primitive type':
    case 'keyword':
      return CompletionItemKind.Keyword;
    case 'var':
    case 'local var':
      return CompletionItemKind.Variable;
    case 'property':
    case 'getter':
    case 'setter':
      return CompletionItemKind.Field;
    case 'function':
    case 'method':
    case 'construct':
    case 'call':
    case 'index':
      return CompletionItemKind.Function;
    case 'enum':
      return CompletionItemKind.Enum;
    case 'module':
      return CompletionItemKind.Module;
    case 'class':
      return CompletionItemKind.Class;
    case 'interface':
      return CompletionItemKind.Interface;
    case 'warning':
      return CompletionItemKind.File;
  }

  return CompletionItemKind.Property;
}

function convertSymbolKind(kind: ts.ScriptElementKind): SymbolKind {
  switch (kind) {
    case 'var':
    case 'local var':
    case 'const':
      return SymbolKind.Variable;
    case 'function':
    case 'local function':
      return SymbolKind.Function;
    case 'enum':
      return SymbolKind.Enum;
    case 'module':
      return SymbolKind.Module;
    case 'class':
      return SymbolKind.Class;
    case 'interface':
      return SymbolKind.Interface;
    case 'method':
      return SymbolKind.Method;
    case 'property':
    case 'getter':
    case 'setter':
      return SymbolKind.Property;
  }
  return SymbolKind.Variable;
}

function convertOptions(
  formatSettings: ts.FormatCodeSettings,
  options: FormattingOptions,
  initialIndentLevel: number
): ts.FormatCodeSettings {
  return _.assign(formatSettings, {
    convertTabsToSpaces: options.insertSpaces,
    tabSize: options.tabSize,
    indentSize: options.tabSize,
    baseIndentSize: options.tabSize * initialIndentLevel
  });
}

function getFormatCodeSettings(config: any): ts.FormatCodeSettings {
  return {
    tabSize: config.vetur.format.options.tabSize,
    indentSize: config.vetur.format.options.tabSize,
    convertTabsToSpaces: !config.vetur.format.options.useTabs
  };
}

function convertCodeAction(
  doc: TextDocument,
  codeActions: ts.CodeAction[],
  regionStart: LanguageModelCache<LanguageRange | undefined>
): TextEdit[] {
  const scriptStartOffset = doc.offsetAt(regionStart.get(doc)!.start);
  const textEdits: TextEdit[] = [];
  for (const action of codeActions) {
    for (const change of action.changes) {
      textEdits.push(
        ...change.textChanges.map(tc => {
          // currently, only import codeAction is available
          // change start of doc to start of script region
          if (tc.span.start <= scriptStartOffset && tc.span.length === 0) {
            const region = regionStart.get(doc);
            if (region) {
              const line = region.start.line;
              return {
                range: Range.create(line + 1, 0, line + 1, 0),
                newText: tc.newText
              };
            }
          }
          return {
            range: convertRange(doc, tc.span),
            newText: tc.newText
          };
        })
      );
    }
  }
  return textEdits;
}
