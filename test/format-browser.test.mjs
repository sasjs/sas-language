/**
 * Guards the browser entry: the same formatting as the node one, with the
 * vocabulary fetched instead of read.
 *
 * The fetch is stubbed, and it reads from the staged `server/node` tree - so the
 * test proves the loader, the retry loop and the pipeline against real data
 * without a network or a web server. What it does not prove is CORS, caching
 * headers or a real CDN; those belong to whoever serves the tree.
 *
 * Two artifacts have to exist: `dist/format.browser.bundle.js`, which
 * `build:format:browser` bundles, and the staged tree, which `build:server`
 * produces. A missing one is a skip with the reason printed, the same shape as
 * `format.test.mjs`.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = path.join(ROOT, 'dist', 'format.browser.bundle.js')
const DATA_ROOT = path.join(ROOT, 'server', 'node')

const skip = () => {
  if (!existsSync(BUNDLE)) {
    return 'dist/format.browser.bundle.js is not built: run npm run build:format:browser'
  }
  if (!existsSync(path.join(DATA_ROOT, 'pubsdata', 'procedures.json'))) {
    return 'no staged language data: run npm run build:server'
  }
  return undefined
}

const reason = skip()

/**
 * A fresh module instance.
 *
 * The entry caches the vocabulary for the life of the page - that is the point
 * of it - so one instance per test is what keeps a test from inheriting another
 * one's cache, and what lets `fetches nothing twice` mean what it says.
 */
let instances = 0
const fresh = () => import(`file://${BUNDLE}?test=${instances++}`)

/** Every URL the formatter asked for, in order, so a cache hit is visible. */
let requests = []

/**
 * A `fetch` over the staged tree.
 *
 * The path after the root is what names the file, which is exactly the contract
 * the loader relies on. `refuse` answers 404 for one named path, so a test can
 * describe a root that is missing a file rather than one that is missing
 * entirely.
 */
const installFetch = (root = '/sas-language/', refuse = '') => {
  requests = []

  globalThis.fetch = async (url) => {
    const request = String(url)
    requests.push(request)

    // Any root is served from the staged tree: everything before `pubsdata/` or
    // `data/` is the root, whatever its depth, and the rest is the file. That is
    // what lets a test use more than one root and prove they do not share a cache.
    const relativePath = request.replace(/^.*?\/(?=pubsdata\/|data\/)/, '')

    if (relativePath === refuse) {
      return { ok: false, status: 404, json: async () => ({}) }
    }

    const file = path.join(DATA_ROOT, relativePath)

    if (!existsSync(file)) return { ok: false, status: 404, json: async () => ({}) }

    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(readFileSync(file, 'utf8'))
    }
  }
}

const run = (name, fn, options = {}) =>
  test(name, async (context) => {
    if (reason) return context.skip(reason)

    installFetch(options.root, options.refuse)
    await fn(await fresh())
  })

run('formats a DATA step from fetched data', async ({ formatText }) => {
  const output = await formatText(
    ['data work.foo;', 'set sashelp.class;', 'if age>12 then flag=1;else flag=0;', 'run;', ''].join(
      '\n'
    )
  )

  assert.equal(
    output,
    [
      'data work.foo;',
      '  set sashelp.class;',
      '  if age>12 then flag=1;',
      '  else flag=0;',
      'run;',
      ''
    ].join('\n')
  )
})

run('fetches a procedure file the retry loop discovers', async ({ formatText }) => {
  const output = await formatText(
    ['proc means data=work.foo n mean std;', 'var age;', 'class flag;', 'run;', ''].join('\n')
  )

  assert.equal(
    output,
    ['proc means data=work.foo n mean std;', '  var age;', '  class flag;', 'run;', ''].join('\n')
  )

  // The core files never name a procedure, so this request can only have come
  // from a miss the loop turned into a fetch.
  assert.ok(
    requests.some((url) => /pubsdata\/Procedures\/en\/means\.json$/i.test(url)),
    `expected a procedure fetch, got ${requests.join(', ')}`
  )
})

run('fetches nothing twice, across calls', async ({ formatText }) => {
  await formatText(['data foo;', 'set bar;', 'run;', ''].join('\n'))

  const first = requests.length
  requests = []

  await formatText(['data foo;', 'set bar;', 'run;', ''].join('\n'))

  assert.ok(first > 0, 'the first call fetched nothing at all')
  assert.equal(requests.length, 0, `re-fetched ${requests.join(', ')}`)
})

run(
  'honours the data root it is given',
  async ({ formatText }) => {
    await formatText(['data foo;', 'run;', ''].join('\n'), {
      dataRoot: '/assets/sas-language'
    })

    assert.ok(
      requests.every((url) => url.startsWith('/assets/sas-language/')),
      `outside the root: ${requests.join(', ')}`
    )
  },
  { root: '/assets/sas-language/' }
)

run('keeps two data roots apart in one instance', async ({ formatText }) => {
  const text = ['data foo;', 'run;', ''].join('\n')

  await formatText(text, { dataRoot: '/a' })

  requests = []

  await formatText(text, { dataRoot: '/b' })

  // A cache keyed on the path alone answers this second call from the first
  // root's vocabulary: no request, and no sign that the wrong data was used.
  assert.ok(
    requests.some((url) => url === '/b/pubsdata/procedures.json'),
    `the second root was not fetched: ${requests.join(', ') || 'nothing'}`
  )
})

run(
  'names the file and the status when the data root does not answer',
  async ({ formatText }) => {
    await assert.rejects(
      () => formatText(['data foo;', 'run;', ''].join('\n'), { dataRoot: '/missing' }),
      /SAS language data is missing: \/missing\/pubsdata\/procedures\.json answered 404/
    )
  },
  { root: '/missing/', refuse: 'pubsdata/procedures.json' }
)
