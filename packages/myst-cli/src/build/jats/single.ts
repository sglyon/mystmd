import path from 'node:path';
import { tic, writeFileToFolder } from 'myst-cli-utils';
import { ExportFormats } from 'myst-frontmatter';
import { writeJats } from 'myst-to-jats';
import type { LinkTransformer } from 'myst-transforms';
import { VFile } from 'vfile';
import { findCurrentProjectAndLoad } from '../../config.js';
import { combineCitationRenderers } from '../../process/citations.js';
import { finalizeMdast } from '../../process/mdast.js';
import { loadProjectFromDisk } from '../../project/load.js';
import { castSession } from '../../session/cache.js';
import type { ISession } from '../../session/types.js';
import { logMessagesFromVFile } from '../../utils/logMessagesFromVFile.js';
import { KNOWN_IMAGE_EXTENSIONS } from '../../utils/resolveExtension.js';
import type { ExportWithOutput, ExportOptions } from '../types.js';
import { cleanOutput } from '../utils/cleanOutput.js';
import { collectBasicExportOptions } from '../utils/collectExportOptions.js';
import { getFileContent } from '../utils/getFileContent.js';
import { resolveAndLogErrors } from '../utils/resolveAndLogErrors.js';

export async function runJatsExport(
  session: ISession,
  sourceFile: string,
  exportOptions: ExportWithOutput,
  projectPath?: string,
  clean?: boolean,
  extraLinkTransformers?: LinkTransformer[],
) {
  const toc = tic();
  const { output, articles, sub_articles } = exportOptions;
  // At this point, export options are resolved to contain one-and-only-one article
  if (articles.length > 1) {
    throw new Error('When specifying a named output for export, you must list exactly one file.');
  }
  const article = articles[0];
  if (!article) return { tempFolders: [] };
  if (clean) cleanOutput(session, output);
  const processedContents = (
    await getFileContent(session, [article, ...(sub_articles ?? [])], {
      projectPath,
      imageExtensions: KNOWN_IMAGE_EXTENSIONS,
      extraLinkTransformers,
    })
  ).map((content) => {
    const { kind, file, mdast, frontmatter, slug } = content;
    const rendererFiles = projectPath ? [projectPath, file] : [file];
    const citations = combineCitationRenderers(castSession(session), ...rendererFiles);
    return { mdast, kind, frontmatter, citations, slug, file };
  });
  await Promise.all(
    processedContents.map(({ mdast, frontmatter, file }) => {
      return finalizeMdast(session, mdast, frontmatter, file, {
        imageWriteFolder: path.join(path.dirname(output), 'files'),
        imageAltOutputFolder: 'files/',
        imageExtensions: KNOWN_IMAGE_EXTENSIONS,
        simplifyFigures: false,
      });
    }),
  );
  const [processedArticle, ...processedSubArticles] = processedContents;
  const vfile = new VFile();
  vfile.path = output;
  const jats = writeJats(vfile, processedArticle as any, {
    subArticles: processedSubArticles as any,
    writeFullArticle: true,
    format: 'pretty',
    abstractParts: [
      { part: 'abstract' },
      {
        part: ['plain-language-summary', 'plain-language-abstract', 'summary'],
        type: 'plain-language-summary',
        title: 'Plain Language Summary',
      },
      { part: 'keypoints', type: 'key-points', title: 'Key Points' },
    ],
    backSections: [
      {
        part: ['data-availability', 'data_availability', 'availability'],
        type: 'data-availability',
        title: 'Data Availability',
      },
    ],
    // if we want to add templating here, we have access to { ...processedArticle.frontmatter.options, ...exportOptions }
  });
  logMessagesFromVFile(session, jats);
  session.log.info(toc(`📑 Exported JATS in %s, copying to ${output}`));
  writeFileToFolder(output, jats.result as string);
  return { tempFolders: [] };
}

export async function localArticleToJats(
  session: ISession,
  file: string,
  opts: ExportOptions,
  templateOptions?: Record<string, any>,
  extraLinkTransformers?: LinkTransformer[],
) {
  let { projectPath } = opts;
  if (!projectPath) projectPath = findCurrentProjectAndLoad(session, path.dirname(file));
  if (projectPath) await loadProjectFromDisk(session, projectPath);
  const exportOptionsList = (
    await collectBasicExportOptions(session, file, 'xml', [ExportFormats.xml], projectPath, opts)
  ).map((exportOptions) => {
    return { ...exportOptions, ...templateOptions };
  });
  await resolveAndLogErrors(
    session,
    exportOptionsList.map(async (exportOptions) => {
      await runJatsExport(
        session,
        file,
        exportOptions,
        projectPath,
        opts.clean,
        extraLinkTransformers,
      );
    }),
    opts.throwOnFailure,
  );
}
