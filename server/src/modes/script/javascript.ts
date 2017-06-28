import { LanguageModelCache, getLanguageModelCache } from '../languageModelCache';
import { SymbolInformation, SymbolKind, CompletionItem, Location, SignatureHelp, SignatureInformation, ParameterInformation, Definition, TextEdit, TextDocument, Diagnostic, DiagnosticSeverity, Range, CompletionItemKind, Hover, MarkedString, DocumentHighlight, DocumentHighlightKind, CompletionList, Position, FormattingOptions } from 'vscode-languageserver-types';
import { LanguageMode } from '../languageModes';
import { getWordAtText } from '../../utils/strings';
import { VueDocumentRegions } from '../embeddedSupport';
import { createUpdater, parseVue, isVue } from './typescript';

import Uri from 'vscode-uri';
import * as path from 'path';
import * as ts from 'typescript';
import * as _ from 'lodash';
import { platform } from 'os';

import { NULL_SIGNATURE, NULL_COMPLETION } from '../nullMode';

import * as bridge from './bridge';

const IS_WINDOWS = platform() === 'win32';
const JS_WORD_REGEX = /(-?\d*\.\d\w*)|([^\`\~\!\@\#\%\^\&\*\(\)\-\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\?\s]+)/g;

export interface ScriptMode extends LanguageMode {
  findComponents(document: TextDocument): string[];
}

export function getJavascriptMode (documentRegions: LanguageModelCache<VueDocumentRegions>, workspacePath: string): ScriptMode {
  const jsDocuments = getLanguageModelCache(10, 60, document => {
    const vueDocument = documentRegions.get(document);
    if (vueDocument.getLanguagesInDocument().indexOf('typescript') > -1) {
      return vueDocument.getEmbeddedDocument('typescript');
    }
    return vueDocument.getEmbeddedDocument('javascript');
  });

  let compilerOptions: ts.CompilerOptions = {
    allowNonTsExtensions: true,
    allowJs: true,
    lib: ['lib.dom.d.ts', 'lib.es2017.d.ts'],
    target: ts.ScriptTarget.Latest,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    module: ts.ModuleKind.CommonJS,
    allowSyntheticDefaultImports: true
  };
  let currentScriptDoc: TextDocument;
  let versions = new Map<string, number>();
  let scriptDocs = new Map<string, TextDocument>();

  // Patch typescript functions to insert `import Vue from 'vue'` and `new Vue` around export default.
  // NOTE: Typescript 2.3 should add an API to allow this, and then this code should use that API.
  const { createLanguageServiceSourceFile, updateLanguageServiceSourceFile } = createUpdater();
  (ts as any).createLanguageServiceSourceFile = createLanguageServiceSourceFile;
  (ts as any).updateLanguageServiceSourceFile = updateLanguageServiceSourceFile;
  const configFilename = ts.findConfigFile(workspacePath, ts.sys.fileExists, 'tsconfig.json') ||
    ts.findConfigFile(workspacePath, ts.sys.fileExists, 'jsconfig.json');
  const configJson = configFilename && ts.readConfigFile(configFilename, ts.sys.readFile).config || {
    exclude: ['node_modules', '**/node_modules/*']
  };
  const parsedConfig = ts.parseJsonConfigFileContent(configJson,
    ts.sys,
    workspacePath,
    compilerOptions,
    configFilename,
    undefined,
    [{ extension: 'vue', isMixedContent: true }]);
  const files = parsedConfig.fileNames;
  compilerOptions = parsedConfig.options;
  compilerOptions.allowNonTsExtensions = true;

  function updateCurrentTextDocument (doc: TextDocument) {
    const fileFsPath = getFileFsPath(doc.uri);
    const filePath = getFilePath(doc.uri);
    // When file is not in language service, add it
    if (!scriptDocs.has(fileFsPath)) {
      if (_.endsWith(fileFsPath, '.vue')) {
        files.push(filePath);
      }
    }
    if (!currentScriptDoc || doc.uri !== currentScriptDoc.uri || doc.version !== currentScriptDoc.version) {
      currentScriptDoc = jsDocuments.get(doc);
      let lastDoc = scriptDocs.get(fileFsPath);
      if (lastDoc && currentScriptDoc.languageId !== lastDoc.languageId) {
        // if languageId changed, restart the language service; it can't handle file type changes
        jsLanguageService.dispose();
        jsLanguageService = ts.createLanguageService(host);
      }
      scriptDocs.set(fileFsPath, currentScriptDoc);
      versions.set(fileFsPath, (versions.get(fileFsPath) || 0) + 1);
    }
  }

  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => compilerOptions,
    getScriptFileNames: () => files,
    getScriptVersion (fileName) {
      if (fileName === bridge.fileName) {
        return '0';
      }
      const normalizedFileFsPath = getNormalizedFileFsPath(fileName);
      let version = versions.get(normalizedFileFsPath);
      return version ? version.toString() : '0';
    },
    getScriptKind (fileName) {
      if (isVue(fileName)) {
        const uri = Uri.file(fileName);
        fileName = uri.fsPath;
        const doc = scriptDocs.get(fileName) ||
          jsDocuments.get(TextDocument.create(uri.toString(), 'vue', 0, ts.sys.readFile(fileName)));
        return doc.languageId === 'typescript' ? ts.ScriptKind.TS : ts.ScriptKind.JS;
      }
      else {
        if (fileName === bridge.fileName) {
          return ts.Extension.Ts;
        }
        // NOTE: Typescript 2.3 should export getScriptKindFromFileName. Then this cast should be removed.
        return (ts as any).getScriptKindFromFileName(fileName);
      }
    },
    resolveModuleNames (moduleNames: string[], containingFile: string): ts.ResolvedModule[] {
      // in the normal case, delegate to ts.resolveModuleName
      // in the relative-imported.vue case, manually build a resolved filename
      return moduleNames.map(name => {
        if (name === bridge.moduleName) {
          return {
            resolvedFileName: bridge.fileName,
            extension: ts.Extension.Ts
          };
        }
        if (path.isAbsolute(name) || !isVue(name)) {
          return ts.resolveModuleName(name, containingFile, compilerOptions, ts.sys).resolvedModule!;
        }
        const uri = Uri.file(path.join(path.dirname(containingFile), name));
        const resolvedFileName = uri.fsPath;
        if (ts.sys.fileExists(resolvedFileName)) {
          const doc = scriptDocs.get(resolvedFileName) ||
            jsDocuments.get(TextDocument.create(uri.toString(), 'vue', 0, ts.sys.readFile(resolvedFileName)));
          return {
            resolvedFileName,
            extension: doc.languageId === 'typescript' ? ts.Extension.Ts : ts.Extension.Js,
          };
        }
        return undefined as any;
      });
    },
    getScriptSnapshot: (fileName: string) => {
      if (fileName === bridge.fileName) {
        let text = bridge.content;
        return {
          getText: (start, end) => text.substring(start, end),
          getLength: () => text.length,
          getChangeRange: () => void 0
        };
      }
      const normalizedFileFsPath = getNormalizedFileFsPath(fileName);
      let doc = scriptDocs.get(normalizedFileFsPath);
      let text = doc ? doc.getText() : (ts.sys.readFile(normalizedFileFsPath) || '');
      if (!doc && isVue(fileName)) {
        // Note: This is required in addition to the parsing in embeddedSupport because
        // this works for .vue files that aren't even loaded by VS Code yet.
        text = parseVue(text);
      }
      return {
        getText: (start, end) => text.substring(start, end),
        getLength: () => text.length,
        getChangeRange: () => void 0
      };
    },
    getCurrentDirectory: () => workspacePath,
    getDefaultLibFileName: ts.getDefaultLibFilePath,
  };

  let jsLanguageService = ts.createLanguageService(host);
  let settings: any = {};

  return {
    getId () {
      return 'javascript';
    },
    configure (options: any) {
      if (options.vetur) {
        settings.format = options.vetur.format.js;
      }
    },
    doValidation (doc: TextDocument): Diagnostic[] {
      updateCurrentTextDocument(doc);
      if (!languageServiceIncludesFile(jsLanguageService, doc.uri)) {
        return [];
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const diagnostics = [...jsLanguageService.getSyntacticDiagnostics(fileFsPath),
      ...jsLanguageService.getSemanticDiagnostics(fileFsPath)];

      return diagnostics.map(diag => {
        // syntactic/semantic diagnostic always has start and length
        // so we can safely cast diag to TextSpan
        return {
          range: convertRange(currentScriptDoc, diag as ts.TextSpan),
          severity: DiagnosticSeverity.Error,
          message: ts.flattenDiagnosticMessageText(diag.messageText, '\n')
        };
      });
    },
    doComplete (doc: TextDocument, position: Position): CompletionList {
      updateCurrentTextDocument(doc);
      if (!languageServiceIncludesFile(jsLanguageService, doc.uri)) {
        return { isIncomplete: false, items: [] };
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const offset = currentScriptDoc.offsetAt(position);
      const completions = jsLanguageService.getCompletionsAtPosition(fileFsPath, offset);
      if (!completions) {
        return { isIncomplete: false, items: [] };
      }
      const wordAtText = getWordAtText(currentScriptDoc.getText(), offset, JS_WORD_REGEX);
      const replaceRange = convertRange(currentScriptDoc, wordAtText);
      const entries = completions.entries.filter(entry => entry.name !== '__vueEditorBridge');
      return {
        isIncomplete: false,
        items: entries.map(entry => {
          return {
            uri: doc.uri,
            position: position,
            label: entry.name,
            sortText: entry.sortText,
            kind: convertKind(entry.kind),
            textEdit: TextEdit.replace(replaceRange, entry.name),
            data: { // data used for resolving item details (see 'doResolve')
              languageId: 'javascript',
              uri: doc.uri,
              offset: offset
            }
          };
        })
      };
    },
    doResolve (doc: TextDocument, item: CompletionItem): CompletionItem {
      updateCurrentTextDocument(doc);
      if (!languageServiceIncludesFile(jsLanguageService, doc.uri)) {
        return NULL_COMPLETION;
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const details = jsLanguageService.getCompletionEntryDetails(fileFsPath, item.data.offset, item.label);
      if (details) {
        item.detail = ts.displayPartsToString(details.displayParts);
        item.documentation = ts.displayPartsToString(details.documentation);
        delete item.data;
      }
      return item;
    },
    doHover (doc: TextDocument, position: Position): Hover {
      updateCurrentTextDocument(doc);
      if (!languageServiceIncludesFile(jsLanguageService, doc.uri)) {
        return { contents: [] };
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const info = jsLanguageService.getQuickInfoAtPosition(fileFsPath, currentScriptDoc.offsetAt(position));
      if (info) {
        const display = ts.displayPartsToString(info.displayParts);
        const doc = ts.displayPartsToString(info.documentation);
        let markedContents: MarkedString[] = [
          { language: 'ts', value: display }
        ];
        if (doc) {
          markedContents.unshift(doc, '\n');
        }
        return {
          range: convertRange(currentScriptDoc, info.textSpan),
          contents: markedContents
        };
      }
      return { contents: [] };
    },
    doSignatureHelp (doc: TextDocument, position: Position): SignatureHelp {
      updateCurrentTextDocument(doc);
      if (!languageServiceIncludesFile(jsLanguageService, doc.uri)) {
        return NULL_SIGNATURE;
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const signHelp = jsLanguageService.getSignatureHelpItems(fileFsPath, currentScriptDoc.offsetAt(position));
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

        signature.label += ts.displayPartsToString(item.prefixDisplayParts);
        item.parameters.forEach((p, i, a) => {
          const label = ts.displayPartsToString(p.displayParts);
          const parameter: ParameterInformation = {
            label: label,
            documentation: ts.displayPartsToString(p.documentation)
          };
          signature.label += label;
          signature.parameters!.push(parameter);
          if (i < a.length - 1) {
            signature.label += ts.displayPartsToString(item.separatorDisplayParts);
          }
        });
        signature.label += ts.displayPartsToString(item.suffixDisplayParts);
        ret.signatures.push(signature);
      });
      return ret;
    },
    findDocumentHighlight (doc: TextDocument, position: Position): DocumentHighlight[] {
      updateCurrentTextDocument(doc);
      if (!languageServiceIncludesFile(jsLanguageService, doc.uri)) {
        return [];
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const occurrences = jsLanguageService.getOccurrencesAtPosition(fileFsPath, currentScriptDoc.offsetAt(position));
      if (occurrences) {
        return occurrences.map(entry => {
          return {
            range: convertRange(currentScriptDoc, entry.textSpan),
            kind: <DocumentHighlightKind>(entry.isWriteAccess ? DocumentHighlightKind.Write : DocumentHighlightKind.Text)
          };
        });
      }
      return [];
    },
    findDocumentSymbols (doc: TextDocument): SymbolInformation[] {
      updateCurrentTextDocument(doc);
      if (!languageServiceIncludesFile(jsLanguageService, doc.uri)) {
        return [];
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const items = jsLanguageService.getNavigationBarItems(fileFsPath);
      if (items) {
        const result: SymbolInformation[] = [];
        const existing: {[k: string]: boolean} = {};
        const collectSymbols = (item: ts.NavigationBarItem, containerLabel?: string) => {
          const sig = item.text + item.kind + item.spans[0].start;
          if (item.kind !== 'script' && !existing[sig]) {
            const symbol: SymbolInformation = {
              name: item.text,
              kind: convertSymbolKind(item.kind),
              location: {
                uri: doc.uri,
                range: convertRange(currentScriptDoc, item.spans[0])
              },
              containerName: containerLabel
            };
            existing[sig] = true;
            result.push(symbol);
            containerLabel = item.text;
          }

          if (item.childItems && item.childItems.length > 0) {
            for (let child of item.childItems) {
              collectSymbols(child, containerLabel);
            }
          }

        };

        items.forEach(item => collectSymbols(item));
        return result;
      }
      return [];
    },
    findDefinition (doc: TextDocument, position: Position): Definition {
      updateCurrentTextDocument(doc);
      if (!languageServiceIncludesFile(jsLanguageService, doc.uri)) {
        return [];
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const definition = jsLanguageService.getDefinitionAtPosition(fileFsPath, currentScriptDoc.offsetAt(position));
      if (!definition) {
        return [];
      }
      return definition.map(d => {
        return {
          uri: doc.uri,
          range: convertRange(currentScriptDoc, d.textSpan)
        };
      });
    },
    findReferences (doc: TextDocument, position: Position): Location[] {
      updateCurrentTextDocument(doc);
      if (!languageServiceIncludesFile(jsLanguageService, doc.uri)) {
        return [];
      }

      const fileFsPath = getFileFsPath(doc.uri);
      const references = jsLanguageService.getReferencesAtPosition(fileFsPath, currentScriptDoc.offsetAt(position));
      if (references) {
        return references.map(d => {
          return {
            uri: doc.uri,
            range: convertRange(currentScriptDoc, d.textSpan)
          };
        });
      }
      return [];
    },
    format (doc: TextDocument, range: Range, formatParams: FormattingOptions): TextEdit[] {
      updateCurrentTextDocument(doc);

      const fileFsPath = getFileFsPath(doc.uri);
      const initialIndentLevel = formatParams.scriptInitialIndent ? 1 : 0;
      const formatSettings = convertOptions(formatParams, settings && settings.format, initialIndentLevel);
      const start = currentScriptDoc.offsetAt(range.start);
      let end = currentScriptDoc.offsetAt(range.end);
      const edits = jsLanguageService.getFormattingEditsForRange(fileFsPath, start, end, formatSettings);
      if (edits) {
        const result = [];
        for (let edit of edits) {
          if (edit.span.start >= start && edit.span.start + edit.span.length <= end) {
            result.push({
              range: convertRange(currentScriptDoc, edit.span),
              newText: edit.newText
            });
          }
        }
        return result;
      }
      return [];
    },
    findComponents(doc: TextDocument) {
      // TODO: refine component info collection
      const fileFsPath = getFileFsPath(doc.uri);
      const program = jsLanguageService.getProgram();
      const sourceFile = program.getSourceFile(fileFsPath);
      const importStmt = sourceFile.statements.filter(st => st.kind === ts.SyntaxKind.ExportAssignment);
      const instance = (importStmt[0] as ts.ExportAssignment).expression as ts.CallExpression;
      const comp = instance.arguments![0];
      const checker = program.getTypeChecker();
      const compType = checker.getTypeAtLocation(comp);
      const compsSymbol = checker.getPropertyOfType(compType, 'components');
      const comps = checker.getTypeOfSymbolAtLocation(compsSymbol!, compsSymbol!.declarations![0]);
      return checker.getPropertiesOfType(comps).map(s => s.name);
    },
    onDocumentRemoved (document: TextDocument) {
      jsDocuments.onDocumentRemoved(document);
    },
    dispose () {
      jsLanguageService.dispose();
      jsDocuments.dispose();
    }
  };

}


function getNormalizedFileFsPath (fileName: string): string {
  return Uri.file(fileName).fsPath;
}

function getFileFsPath (documentUri: string): string {
  return Uri.parse(documentUri).fsPath;
}

function getFilePath (documentUri: string): string {
  if (IS_WINDOWS) {
    // Windows have a leading slash like /C:/Users/pine
    return Uri.parse(documentUri).path.slice(1);
  } else {
    return Uri.parse(documentUri).path;
  }
}

function languageServiceIncludesFile (ls: ts.LanguageService, documentUri: string): boolean {
  const filePaths = ls.getProgram().getRootFileNames();
  const filePath = getFilePath(documentUri);
  return filePaths.includes(filePath);
}

function convertRange (document: TextDocument, span: ts.TextSpan): Range {
  const startPosition = document.positionAt(span.start);
  const endPosition = document.positionAt(span.start + span.length);
  return Range.create(startPosition, endPosition);
}

function convertKind (kind: string): CompletionItemKind {
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

function convertSymbolKind (kind: string): SymbolKind {
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

function convertOptions (options: FormattingOptions, formatSettings: any, initialIndentLevel: number): ts.FormatCodeOptions {
  const defaultJsFormattingOptions = {
    ConvertTabsToSpaces: options.insertSpaces,
    TabSize: options.tabSize,
    IndentSize: options.tabSize,
    IndentStyle: ts.IndentStyle.Smart,
    NewLineCharacter: '\n',
    BaseIndentSize: options.tabSize * initialIndentLevel,
    InsertSpaceAfterCommaDelimiter: true,
    InsertSpaceAfterSemicolonInForStatements: true,
    InsertSpaceAfterKeywordsInControlFlowStatements: true,
    InsertSpaceAfterFunctionKeywordForAnonymousFunctions: true,
    InsertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis: false,
    InsertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets: false,
    InsertSpaceAfterOpeningAndBeforeClosingTemplateStringBraces: false,
    InsertSpaceBeforeFunctionParenthesis: true,
    InsertSpaceBeforeAndAfterBinaryOperators: true,
    PlaceOpenBraceOnNewLineForControlBlocks: false,
    PlaceOpenBraceOnNewLineForFunctions: false
  };

  return _.assign(defaultJsFormattingOptions, formatSettings);
}
