import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { tic } from 'myst-cli-utils';
import { TexParser } from 'tex-to-myst';
import { VFile } from 'vfile';
import { RuleId, toText } from 'myst-common';
import type { PageFrontmatter } from 'myst-frontmatter';
import { SourceFileKind } from 'myst-spec-ext';
import type { ICacheItem, ISession, ISessionWithCache } from '../session/types.js';
import { castSession } from '../session/cache.js';
import { warnings, watch } from '../store/reducers.js';
import type { RendererData } from '../transforms/types.js';
import { logMessagesFromVFile } from '../utils/logMessagesFromVFile.js';
import { addWarningForFile } from '../utils/addWarningForFile.js';
import { loadCitations } from './citations.js';
import { parseMyst } from './myst.js';
import { processNotebook } from './notebook.js';

function checkCache(cache: ISessionWithCache, content: string, file: string) {
  const sha256 = createHash('sha256').update(content).digest('hex');
  cache.store.dispatch(watch.actions.markFileChanged({ path: file, sha256 }));
  const mdast = cache.$getMdast(file);
  const useCache = mdast?.pre && mdast.sha256 === sha256;
  return { mdast: useCache ? mdast : undefined, sha256 };
}

/**
 * Load a Markdown file, parse the AST, and cache the result.
 * If the file is already cached, return the cache item.
 *
 * @param cachingSession session with logging and cache
 * @param file Markdown file to load
 * @param location location relative to project root
 */
async function loadMarkdownFile(cachingSession: ISessionWithCache, file: string, location: string) {
  const content = fs.readFileSync(file).toString();
  const { sha256, mdast } = checkCache(cachingSession, content, file);
  if (mdast !== undefined) {
    return mdast;
  }
  const cacheItem = {
    sha256,
    pre: {
      kind: SourceFileKind.Article,
      file,
      location,
      mdast: parseMyst(cachingSession, content, file),
    },
  };
  cachingSession.$setMdast(file, cacheItem);
  return cacheItem;
}

/**
 * Load a Jupyter notebook, parse the AST, and cache the result.
 * If the file is already cached, return the cache item.
 *
 * @param cachingSession session with logging and cache
 * @param file Markdown file to load
 * @param location location relative to project root
 */
async function loadJupyterNotebookFile(
  cachingSession: ISessionWithCache,
  file: string,
  location: string,
  opts?: { minifyMaxCharacters?: number },
): Promise<ICacheItem> {
  const content = fs.readFileSync(file).toString();
  const { sha256, mdast } = checkCache(cachingSession, content, file);
  if (mdast !== undefined) {
    return mdast;
  }
  const cacheItem = {
    sha256,
    pre: {
      kind: SourceFileKind.Notebook,
      file,
      location,
      mdast: await processNotebook(cachingSession, file, content, opts),
    },
  };
  cachingSession.$setMdast(file, cacheItem);
  return cacheItem;
}

/**
 * Load a LaTeX file, parse the AST, and cache the result.
 * If the file is already cached, return the cache item.
 *
 * @param cachingSession session with logging and cache
 * @param file Markdown file to load
 * @param location location relative to project root
 */
async function loadLaTeXFile(
  cachingSession: ISessionWithCache,
  file: string,
  location: string,
): Promise<ICacheItem> {
  const content = fs.readFileSync(file).toString();
  const { sha256, mdast } = checkCache(cachingSession, content, file);
  if (mdast !== undefined) {
    return mdast;
  }
  const vfile = new VFile();
  vfile.path = file;
  const tex = new TexParser(content, vfile);
  logMessagesFromVFile(cachingSession, vfile);
  const frontmatter: PageFrontmatter = {
    title: toText(tex.data.frontmatter.title as any),
    short_title: toText(tex.data.frontmatter.short_title as any),
    authors: tex.data.frontmatter.authors,
    // TODO: affiliations: tex.data.frontmatter.affiliations,
    keywords: tex.data.frontmatter.keywords,
    math: tex.data.macros,
    bibliography: tex.data.bibliography,
  };
  const cacheItem = {
    sha256,
    pre: {
      kind: SourceFileKind.Article,
      file,
      mdast: tex.ast as any,
      location,
      frontmatter,
    },
  };
  cachingSession.$setMdast(file, cacheItem);
  return cacheItem;
}

/**
 * Attempt to load a file into the current session. Unsupported files with
 * issue a warning
 *
 * @param session session with logging
 * @param file path to file to load
 * @param projectPath path to project directory
 * @param extension pre-computed file extension
 * @param opts loading options
 */
export async function loadFile(
  session: ISession,
  file: string,
  projectPath?: string,
  extension?: '.md' | '.ipynb' | '.bib',
  opts?: { minifyMaxCharacters?: number },
) {
  await session.loadPlugins();
  const toc = tic();
  session.store.dispatch(warnings.actions.clearWarnings({ file }));
  const cache = castSession(session);
  let success = true;

  let location = file;
  if (projectPath) {
    location = `/${path.relative(projectPath, file)}`;
  }
  // ensure forward slashes and not windows backslashes
  location = location.replaceAll('\\', '/');

  try {
    const ext = extension || path.extname(file).toLowerCase();
    switch (ext) {
      case '.md': {
        await loadMarkdownFile(cache, file, location);
        break;
      }
      case '.ipynb': {
        await loadJupyterNotebookFile(cache, file, location, opts);
        break;
      }
      case '.tex': {
        await loadLaTeXFile(cache, file, location);
        break;
      }
      case '.bib': {
        const renderer = await loadCitations(session, file);
        cache.$citationRenderers[file] = renderer;
        break;
      }
      default:
        addWarningForFile(session, file, 'Unrecognized extension', 'error', {
          ruleId: RuleId.mystFileLoads,
        });
        session.log.info(
          `"${file}": Please rerun the build with "-c" to ensure the built files are cleared.`,
        );
        success = false;
    }
  } catch (error) {
    session.log.debug(`\n\n${(error as Error)?.stack}\n\n`);
    addWarningForFile(session, file, `Error reading file: ${error}`, 'error', {
      ruleId: RuleId.mystFileLoads,
    });
    success = false;
  }
  if (success) session.log.debug(toc(`loadFile: loaded ${file} in %s.`));
}

/**
 * Find bibliography files in the given directory, loading them if required
 *
 * @param session session with logging
 * @param dir directory to search
 * @param load load bib files in addition to locating them
 */
export async function bibFilesInDir(session: ISession, dir: string, load = true) {
  const bibFiles = await Promise.all(
    fs.readdirSync(dir).map(async (f) => {
      if (path.extname(f).toLowerCase() === '.bib') {
        const bibFile = path.join(dir, f);
        if (load) await loadFile(session, bibFile);
        return bibFile;
      }
    }),
  );
  return bibFiles.filter((f): f is string => Boolean(f));
}

/**
 * Return the cached post-processed MDAST for the given file, or return undefined
 *
 * @param session session with logging
 * @param file path to file
 */
export function selectFile(session: ISession, file: string): RendererData | undefined {
  const cache = castSession(session);
  if (!cache.$getMdast(file)) {
    addWarningForFile(session, file, `Expected mdast to be processed`, 'error', {
      ruleId: RuleId.selectedFileIsProcessed,
    });
    return undefined;
  }
  const mdastPost = cache.$getMdast(file)?.post;
  if (!mdastPost) {
    addWarningForFile(session, file, `Expected mdast to be processed and transformed`, 'error', {
      ruleId: RuleId.selectedFileIsProcessed,
    });
    return undefined;
  }
  return mdastPost;
}
