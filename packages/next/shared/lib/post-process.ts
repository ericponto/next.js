import { parse, HTMLElement } from 'next/dist/compiled/node-html-parser'
import { OPTIMIZED_FONT_PROVIDERS } from './constants'

// const MIDDLEWARE_TIME_BUDGET = parseInt(process.env.__POST_PROCESS_MIDDLEWARE_TIME_BUDGET || '', 10) || 10

type postProcessOptions = {
  optimizeFonts: boolean
}

type renderOptions = {
  getFontDefinition?: (url: string) => string
}
interface PostProcessMiddleware {
  inspect: (originalDom: HTMLElement, options: renderOptions) => any
  mutate: (markup: string, data: any, options: renderOptions) => Promise<string>
}

type middlewareSignature = {
  name: string
  middleware: PostProcessMiddleware
  condition: ((options: postProcessOptions) => boolean) | null
}

const middlewareRegistry: Array<middlewareSignature> = []

function registerPostProcessor(
  name: string,
  middleware: PostProcessMiddleware,
  condition?: (options: postProcessOptions) => boolean
) {
  middlewareRegistry.push({ name, middleware, condition: condition || null })
}

async function processHTML(
  html: string,
  data: renderOptions,
  options: postProcessOptions
): Promise<string> {
  // Don't parse unless there's at least one processor middleware
  if (!middlewareRegistry[0]) {
    return html
  }
  const root: HTMLElement = parse(html)
  let document = html

  // Calls the middleware, with some instrumentation and logging
  async function callMiddleWare(middleware: PostProcessMiddleware) {
    // let timer = Date.now()
    const inspectData = middleware.inspect(root, data)
    document = await middleware.mutate(document, inspectData, data)
    // timer = Date.now() - timer
    // if (timer > MIDDLEWARE_TIME_BUDGET) {
    // TODO: Identify a correct upper limit for the postprocess step
    // and add a warning to disable the optimization
    // }
    return
  }

  for (let i = 0; i < middlewareRegistry.length; i++) {
    let middleware = middlewareRegistry[i]
    if (!middleware.condition || middleware.condition(options)) {
      await callMiddleWare(middlewareRegistry[i].middleware)
    }
  }

  return document
}

class FontOptimizerMiddleware implements PostProcessMiddleware {
  inspect(originalDom: HTMLElement, options: renderOptions) {
    if (!options.getFontDefinition) {
      return
    }
    const fontDefinitions: (string | undefined)[][] = []
    // collecting all the requested font definitions
    originalDom
      .querySelectorAll('link')
      .filter(
        (tag: HTMLElement) =>
          tag.getAttribute('rel') === 'stylesheet' &&
          tag.hasAttribute('data-href') &&
          OPTIMIZED_FONT_PROVIDERS.some(({ url }) => {
            const dataHref = tag.getAttribute('data-href')
            return dataHref ? dataHref.startsWith(url) : false
          })
      )
      .forEach((element: HTMLElement) => {
        const url = element.getAttribute('data-href')
        const nonce = element.getAttribute('nonce')

        if (url) {
          fontDefinitions.push([url, nonce])
        }
      })

    return fontDefinitions
  }
  mutate = async (
    markup: string,
    fontDefinitions: string[][],
    options: renderOptions
  ) => {
    let result = markup
    let preconnectUrls = new Set<string>()

    if (!options.getFontDefinition) {
      return markup
    }

    fontDefinitions.forEach((fontDef) => {
      const [url, nonce] = fontDef
      const fallBackLinkTag = `<link rel="stylesheet" href="${url}"/>`
      if (
        result.indexOf(`<style data-href="${url}">`) > -1 ||
        result.indexOf(fallBackLinkTag) > -1
      ) {
        // The font is already optimized and probably the response is cached
        return
      }
      const fontContent = options.getFontDefinition
        ? options.getFontDefinition(url as string)
        : null
      if (!fontContent) {
        /**
         * In case of unreachable font definitions, fallback to default link tag.
         */
        result = result.replace('</head>', `${fallBackLinkTag}</head>`)
      } else {
        const nonceStr = nonce ? ` nonce="${nonce}"` : ''
        result = result.replace(
          '</head>',
          `<style data-href="${url}"${nonceStr}>${fontContent}</style></head>`
        )

        // Remove inert font tag
        const escapedUrl = url
          .replace(/&/g, '&amp;')
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const fontRegex = new RegExp(
          `<link[^>]*data-href="${escapedUrl}"[^>]*/>`
        )
        result = result.replace(fontRegex, '')

        const provider = OPTIMIZED_FONT_PROVIDERS.find((p) =>
          url.startsWith(p.url)
        )

        if (provider) {
          preconnectUrls.add(provider.preconnect)
        }
      }
    })

    let preconnectTag = ''
    preconnectUrls.forEach((url) => {
      preconnectTag += `<link rel="preconnect" href="${url}" crossorigin />`
    })

    result = result.replace(
      '<meta name="next-font-preconnect"/>',
      preconnectTag
    )

    return result
  }
}

// Initialization
registerPostProcessor(
  'Inline-Fonts',
  new FontOptimizerMiddleware(),
  // Using process.env because passing Experimental flag through loader is not possible.
  // @ts-ignore
  (options) => options.optimizeFonts || process.env.__NEXT_OPTIMIZE_FONTS
)

export default processHTML
