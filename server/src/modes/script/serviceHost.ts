import * as path from 'path';
import * as ts from 'typescript';
import Uri from 'vscode-uri';
import { TextDocument } from 'vscode-languageserver-types';
import * as parseGitIgnore from 'parse-gitignore';

import { LanguageModelCache } from '../../embeddedSupport/languageModelCache';
import { createUpdater, parseVueScript, isVue } from './preprocess';
import { getFileFsPath, getFilePath } from '../../utils/paths';
import * as bridge from './bridge';
import { VueDocumentInfo, DocumentRegion, DocumentRegionSnapshot } from '../../services/documentService';
import { ExternalDocumentService } from '../../services/externalDocumentService';
import { T_TypeScript } from '../../services/dependencyService';

function patchTS(tsModule: T_TypeScript) {
  // Patch typescript functions to insert `import Vue from 'vue'` and `new Vue` around export default.
  // NOTE: this is a global hack that all ts instances after is changed
  const { createLanguageServiceSourceFile, updateLanguageServiceSourceFile } = createUpdater(tsModule);
  (tsModule as any).createLanguageServiceSourceFile = createLanguageServiceSourceFile;
  (tsModule as any).updateLanguageServiceSourceFile = updateLanguageServiceSourceFile;
}

function getVueSys(tsModule: T_TypeScript) {
  const vueSys: ts.System = {
    ...tsModule.sys,
    fileExists(path: string) {
      if (isVirtualVueFile(path)) {
        return tsModule.sys.fileExists(path.slice(0, -'.ts'.length));
      }
      if (isVirtualVueTemplateFile(path)) {
        return tsModule.sys.fileExists(path.slice(0, -'.template'.length));
      }
      return tsModule.sys.fileExists(path);
    },
    readFile(path, encoding) {
      if (isVirtualVueFile(path)) {
        const fileText = tsModule.sys.readFile(path.slice(0, -'.ts'.length), encoding);
        return fileText ? parseVueScript(fileText) : fileText;
      }
      if (isVirtualVueTemplateFile(path)) {
        return tsModule.sys.readFile(path.slice(0, -'.template'.length), encoding);
      }
      const fileText = tsModule.sys.readFile(path, encoding);
      return fileText;
    }
  };

  if (tsModule.sys.realpath) {
    const realpath = tsModule.sys.realpath;
    vueSys.realpath = function(path) {
      if (isVirtualVueFile(path)) {
        return realpath(path.slice(0, -'.ts'.length)) + '.ts';
      }
      if (isVirtualVueTemplateFile(path)) {
        return realpath(path.slice(0, -'.template'.length)) + '.ts';
      }
      return realpath(path);
    };
  }

  return vueSys;
}

function getDefaultCompilerOptions(tsModule: T_TypeScript) {
  const defaultCompilerOptions: ts.CompilerOptions = {
    allowNonTsExtensions: true,
    allowJs: true,
    lib: ['lib.dom.d.ts', 'lib.es2017.d.ts'],
    target: tsModule.ScriptTarget.Latest,
    moduleResolution: tsModule.ModuleResolutionKind.NodeJs,
    module: tsModule.ModuleKind.CommonJS,
    jsx: tsModule.JsxEmit.Preserve,
    allowSyntheticDefaultImports: true
  };

  return defaultCompilerOptions;
}

export function getServiceHost(
  tsModule: T_TypeScript,
  workspacePath: string,
  jsDocuments: LanguageModelCache<DocumentRegion>,
  externalDocumentService: ExternalDocumentService
) {
  patchTS(tsModule);
  const vueSys = getVueSys(tsModule);
  let currentScriptDoc: DocumentRegion;
  const versions = new Map<string, number>();
  const scriptDocs = new Map<string, DocumentRegion>();

  const parsedConfig = getParsedConfig(tsModule, workspacePath);
  const files = parsedConfig.fileNames;
  const bridgeSnapshot = new DocumentRegionSnapshot(
    new DocumentRegion(
      TextDocument.create(
        bridge.fileName,
        'vue',
        1,
        inferIsOldVersion(tsModule, workspacePath) ? bridge.oldContent : bridge.content
      )
    )
  );
  const compilerOptions = {
    ...getDefaultCompilerOptions(tsModule),
    ...parsedConfig.options
  };
  compilerOptions.allowNonTsExtensions = true;

  function updateCurrentTextDocument(doc: VueDocumentInfo) {
    const fileFsPath = getFileFsPath(doc.uri);
    const filePath = getFilePath(doc.uri);
    // When file is not in language service, add it
    if (!scriptDocs.has(fileFsPath)) {
      if (fileFsPath.endsWith('.vue') || fileFsPath.endsWith('.vue.template')) {
        files.push(filePath);
      }
    }
    if (isVirtualVueTemplateFile(fileFsPath)) {
      scriptDocs.set(fileFsPath, new DocumentRegion(doc));
      versions.set(fileFsPath, (versions.get(fileFsPath) || 0) + 1);
    } else if (!currentScriptDoc || doc.uri !== currentScriptDoc.uri || doc.version !== currentScriptDoc.version) {
      currentScriptDoc = jsDocuments.get(doc);
      const lastDoc = scriptDocs.get(fileFsPath)!;
      if (lastDoc && currentScriptDoc.languageId !== lastDoc.languageId) {
        // if languageId changed, restart the language service; it can't handle file type changes
        jsLanguageService.dispose();
        jsLanguageService = tsModule.createLanguageService(jsHost);
      }
      scriptDocs.set(fileFsPath, currentScriptDoc);
      versions.set(fileFsPath, (versions.get(fileFsPath) || 0) + 1);
    }
    return {
      service: jsLanguageService,
      templateService: templateLanguageService,
      scriptDoc: currentScriptDoc
    };
  }

  // External Documents: JS/TS, non Vue documents
  function updateExternalDocument(filePath: string) {
    const ver = versions.get(filePath) || 0;
    versions.set(filePath, ver + 1);
  }

  function getScriptDocByFsPath(fsPath: string) {
    return scriptDocs.get(fsPath);
  }

  function createLanguageServiceHost(options: ts.CompilerOptions): ts.LanguageServiceHost {
    return {
      getCompilationSettings: () => options,
      getScriptFileNames: () => files,
      getScriptVersion(fileName) {
        if (fileName === bridge.fileName) {
          return '0';
        }
        const normalizedFileFsPath = getNormalizedFileFsPath(fileName);
        const version = versions.get(normalizedFileFsPath);
        return version ? version.toString() : '0';
      },
      getScriptKind(fileName) {
        if (isVue(fileName)) {
          const uri = Uri.file(fileName);
          fileName = uri.fsPath;
          const doc =
            scriptDocs.get(fileName) ||
            jsDocuments.get(TextDocument.create(uri.toString(), 'vue', 0, tsModule.sys.readFile(fileName) || ''));
          return getScriptKind(tsModule, doc.languageId);
        } else if (isVirtualVueTemplateFile(fileName)) {
          return tsModule.Extension.Js;
        } else {
          if (fileName === bridge.fileName) {
            return tsModule.Extension.Ts;
          }
          // NOTE: Typescript 2.3 should export getScriptKindFromFileName. Then this cast should be removed.
          return (tsModule as any).getScriptKindFromFileName(fileName);
        }
      },

      // resolve @types, see https://github.com/Microsoft/TypeScript/issues/16772
      getDirectories: vueSys.getDirectories,
      directoryExists: vueSys.directoryExists,
      fileExists: vueSys.fileExists,
      readFile: vueSys.readFile,
      readDirectory: vueSys.readDirectory,

      resolveModuleNames(moduleNames: string[], containingFile: string): ts.ResolvedModule[] {
        // in the normal case, delegate to ts.resolveModuleName
        // in the relative-imported.vue case, manually build a resolved filename
        return moduleNames.map(name => {
          if (name === bridge.moduleName) {
            return {
              resolvedFileName: bridge.fileName,
              extension: tsModule.Extension.Ts
            };
          }
          if (path.isAbsolute(name) || !isVue(name)) {
            return tsModule.resolveModuleName(name, containingFile, options, tsModule.sys).resolvedModule;
          }
          const resolved = tsModule.resolveModuleName(name, containingFile, options, vueSys).resolvedModule;
          if (!resolved) {
            return undefined as any;
          }
          if (!resolved.resolvedFileName.endsWith('.vue.ts')) {
            return resolved;
          }
          const resolvedFileName = resolved.resolvedFileName.slice(0, -'.ts'.length);
          const uri = Uri.file(resolvedFileName);
          const doc =
            scriptDocs.get(resolvedFileName) ||
            jsDocuments.get(
              TextDocument.create(uri.toString(), 'vue', 0, tsModule.sys.readFile(resolvedFileName) || '')
            );
          const extension =
            doc.languageId === 'typescript'
              ? tsModule.Extension.Ts
              : doc.languageId === 'tsx'
              ? tsModule.Extension.Tsx
              : tsModule.Extension.Js;
          return { resolvedFileName, extension };
        });
      },
      getScriptSnapshot: (fileName: string) => {
        if (fileName === bridge.fileName) {
          return bridgeSnapshot;
        }
        const normalizedFileFsPath = getNormalizedFileFsPath(fileName);
        const doc = scriptDocs.get(normalizedFileFsPath);
        if (doc) {
          return doc.snapshot;
        }

        const info = externalDocumentService.getOrLoadDocument(Uri.file(fileName));
        return info.snapshot;
      },
      getCurrentDirectory: () => workspacePath,
      getDefaultLibFileName: tsModule.getDefaultLibFilePath,
      getNewLine: () => '\n',
      useCaseSensitiveFileNames: () => true
    };
  }

  const jsHost = createLanguageServiceHost(compilerOptions);
  const templateHost = createLanguageServiceHost({
    ...compilerOptions,
    noImplicitAny: false,
    noUnusedLocals: false,
    noUnusedParameters: false,
    allowJs: true,
    checkJs: true
  });

  const registry = tsModule.createDocumentRegistry(true);
  let jsLanguageService = tsModule.createLanguageService(jsHost, registry);
  const templateLanguageService = tsModule.createLanguageService(templateHost, registry);

  return {
    updateCurrentTextDocument,
    updateExternalDocument,
    getScriptDocByFsPath,
    dispose: () => {
      jsLanguageService.dispose();
    }
  };
}

function getNormalizedFileFsPath(fileName: string): string {
  return Uri.file(fileName).fsPath;
}

/**
 * If the path ends with `.vue.ts`, it's a `.vue` file pre-processed by Vetur
 * to be used in TS Language Service
 */
function isVirtualVueFile(path: string) {
  return path.endsWith('.vue.ts') && !path.includes('node_modules');
}
/**
 * If the path ends with `.vue.template`, it's a `.vue` file's template part
 * pre-processed by Vetur to calculate template diagnostics in TS Language Service
 */
export function isVirtualVueTemplateFile(path: string) {
  return path.endsWith('.vue.template');
}

function defaultIgnorePatterns(tsModule: T_TypeScript, workspacePath: string) {
  const nodeModules = ['node_modules', '**/node_modules/*'];
  const gitignore = tsModule.findConfigFile(workspacePath, tsModule.sys.fileExists, '.gitignore');
  if (!gitignore) {
    return nodeModules;
  }
  const parsed: string[] = parseGitIgnore(gitignore);
  const filtered = parsed.filter(s => !s.startsWith('!'));
  return nodeModules.concat(filtered);
}

function getScriptKind(tsModule: T_TypeScript, langId: string): ts.ScriptKind {
  return langId === 'typescript'
    ? tsModule.ScriptKind.TS
    : langId === 'tsx'
    ? tsModule.ScriptKind.TSX
    : tsModule.ScriptKind.JS;
}

function inferIsOldVersion(tsModule: T_TypeScript, workspacePath: string): boolean {
  const packageJSONPath = tsModule.findConfigFile(workspacePath, tsModule.sys.fileExists, 'package.json');
  try {
    const packageJSON = packageJSONPath && JSON.parse(tsModule.sys.readFile(packageJSONPath)!);
    const vueStr = packageJSON.dependencies.vue || packageJSON.devDependencies.vue;
    // use a sloppy method to infer version, to reduce dep on semver or so
    const vueDep = vueStr.match(/\d+\.\d+/)[0];
    const sloppyVersion = parseFloat(vueDep);
    return sloppyVersion < 2.5;
  } catch (e) {
    return true;
  }
}

function getParsedConfig(tsModule: T_TypeScript, workspacePath: string) {
  const configFilename =
    tsModule.findConfigFile(workspacePath, tsModule.sys.fileExists, 'tsconfig.json') ||
    tsModule.findConfigFile(workspacePath, tsModule.sys.fileExists, 'jsconfig.json');
  const configJson = (configFilename && tsModule.readConfigFile(configFilename, tsModule.sys.readFile).config) || {
    exclude: defaultIgnorePatterns(tsModule, workspacePath)
  };
  // existingOptions should be empty since it always takes priority
  return tsModule.parseJsonConfigFileContent(
    configJson,
    tsModule.sys,
    workspacePath,
    /*existingOptions*/ {},
    configFilename,
    /*resolutionStack*/ undefined,
    [{ extension: 'vue', isMixedContent: true }]
  );
}
