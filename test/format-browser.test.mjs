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
 * entirely. `stall` never settles for a named path, which is the host that accepts
 * a connection and never answers; `stallBody` answers the headers and then never
 * sends the body, which is a different failure a timeout has to cover too.
 */
const installFetch = (
  root = '/sas-language/',
  refuse = '',
  stall = '',
  stallBody = '',
  broken = ''
) => {
  requests = []

  globalThis.fetch = async (url, options = {}) => {
    const request = String(url)
    requests.push(request)

    // Any root is served from the staged tree: everything before `pubsdata/` or
    // `data/` is the root, whatever its depth, and the rest is the file. That is
    // what lets a test use more than one root and prove they do not share a cache.
    const relativePath = request.replace(/^.*?\/(?=pubsdata\/|data\/)/, '')

    if (stall && request.startsWith(stall)) {
      return new Promise((resolve, reject) => {
        // honour the abort, as a real fetch does, and settle for nothing else
        options.signal?.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      })
    }

    if (broken && request.startsWith(broken)) {
      // what a browser throws for CORS, DNS or a dropped connection
      throw new TypeError('Failed to fetch')
    }

    if (stallBody && request.startsWith(stallBody)) {
      return {
        ok: true,
        status: 200,
        // the headers arrived; the body never does
        json: () =>
          new Promise((resolve, reject) => {
            options.signal?.addEventListener('abort', () => {
              const error = new Error('aborted')
              error.name = 'AbortError'
              reject(error)
            })
          })
      }
    }

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
  // a test that would hang without the guard it describes is given a timeout, so
  // the regression fails in seconds rather than stalling the suite
  test(name, options.timeout ? { timeout: options.timeout } : {}, async (context) => {
    if (reason) return context.skip(reason)

    installFetch(options.root, options.refuse, options.stall, options.stallBody, options.broken)
    await fn(await fresh())
  })

run('aligns macro end after a value through the browser entry', async ({ formatText }) => {
  const input = '%macro f();\n%do;\n&value\n%end;\n%mend f;\n'
  const expected = '%macro f();\n  %do;\n    &value\n  %end;\n%mend f;\n'
  assert.equal(await formatText(input), expected)
})

run('formats standalone macro calls through the browser entry', async ({ formatText }) => {
  const input = '%first(a=(1))\n\n%second(b=2)\n%let x=1;\n'
  assert.equal(await formatText(input), input)
})

test('ships the browser declaration the export map promises', (context) => {
  if (reason) return context.skip(reason)

  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const format = manifest.exports['./format']
  const types = readFileSync(path.join(ROOT, 'dist', 'format.browser.d.ts'), 'utf8')

  // `browser` has to be matched before the top-level `types`, which TypeScript
  // reads first whatever the consumer's conditions: nested under it, the browser
  // signature is unreachable and a browser consumer is checked against the node one.
  assert.equal(Object.keys(format)[0], 'browser')
  assert.equal(format.browser.types, './dist/format.browser.d.ts')
  assert.match(types, /fetchTimeoutMs\?: number/)
  assert.match(types, /dataRoot\?: string/)
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

run('reads the default root when the root is an empty string', async ({ formatText }) => {
  // `dataRoot: ''` is a caller saying nothing rather than naming the origin: a join
  // would make it `/` and then 404 against a root nobody asked for
  await formatText(['data foo;', 'run;', ''].join('\n'), { dataRoot: '' })

  assert.ok(
    requests.every((url) => url.startsWith('/sas-language/')),
    `outside the default root: ${requests.join(', ')}`
  )
})

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

run('keeps two data roots apart when both calls are in flight', async ({ formatText }) => {
  const text = ['data foo;', 'run;', ''].join('\n')

  // Neither call is awaited before the second starts: that is the shape the
  // module-wide root cannot survive on its own, because the loader reads whichever
  // root the most recent call assigned. Queued, the `/a` call finishes before `/b`
  // begins, so every `/a` request comes first and each call formats with its own
  // vocabulary.
  const first = formatText(text, { dataRoot: '/a' })
  const second = formatText(text, { dataRoot: '/b' })

  const [a, b] = await Promise.all([first, second])

  assert.equal(a, text)
  assert.equal(b, text)

  const lastA = requests.map((url) => url.startsWith('/a/')).lastIndexOf(true)
  const firstB = requests.map((url) => url.startsWith('/b/')).indexOf(true)

  assert.ok(lastA >= 0 && firstB >= 0, `both roots were not fetched: ${requests.join(', ')}`)
  assert.ok(lastA < firstB, `the calls overlapped: ${requests.join(', ')}`)
})

run(
  'fails a stalled fetch, and lets the call behind it run',
  async ({ formatText }) => {
    const text = ['data foo;', 'run;', ''].join('\n')

    // The first call's root accepts and never answers. Bounded, its request is
    // aborted, the call rejects with a sentence naming the file - and the queue
    // drains, so the call that was waiting behind it still formats.
    const stalled = formatText(text, { dataRoot: '/slow', fetchTimeoutMs: 20 })
    const after = formatText(text, { dataRoot: '/sas-language/' })

    const [first, second] = await Promise.allSettled([stalled, after])

    assert.equal(first.status, 'rejected')
    assert.match(
      first.reason.message,
      /SAS language data could not be read: \/slow\/pubsdata\/procedures\.json did not answer within 0\.02s/
    )

    assert.equal(second.status, 'fulfilled')
    assert.equal(second.value, text)
  },
  { root: '/sas-language/', stall: '/slow/', timeout: 10_000 }
)

run(
  'fails a body that stalls after the headers',
  async ({ formatText }) => {
    const text = ['data foo;', 'run;', ''].join('\n')

    // A host that answers 200 and then never sends the body: the request itself
    // settles, so a timer around the fetch alone would miss it and the queue would
    // stay held by the pending read.
    const stalled = formatText(text, { dataRoot: '/slow-body', fetchTimeoutMs: 20 })
    const after = formatText(text, { dataRoot: '/sas-language/' })

    const [first, second] = await Promise.allSettled([stalled, after])

    assert.equal(first.status, 'rejected')
    assert.match(
      first.reason.message,
      /SAS language data could not be read: \/slow-body\/pubsdata\/procedures\.json did not answer within 0\.02s/
    )

    assert.equal(second.status, 'fulfilled')
    assert.equal(second.value, text)
  },
  { root: '/sas-language/', stallBody: '/slow-body/', timeout: 10_000 }
)

run(
  'stops at the fetch budget, and formats against the last file it fetches',
  async ({ formatText }) => {
    const text = [
      'proc means data=work.foo;',
      'var age;',
      'run;',
      'proc freq data=work.foo;',
      'tables flag;',
      'run;',
      ''
    ].join('\n')

    // One procedure file per attempt, so a budget of one puts the boundary exactly
    // between the two: the first file is fetched and formatted against, the second
    // is the fetch the budget refuses to spend.
    await assert.rejects(
      () => formatText(text, { maxFetches: 1 }),
      /asked for more than 1 file\(s\)/
    )

    const spent = requests.length

    assert.equal(spent, 8, `expected the core set plus one file, got ${requests.join(', ')}`)
    assert.ok(
      requests.some((url) => /pubsdata\/Procedures\/en\/means\.json$/i.test(url)),
      'the file the budget allowed was not fetched'
    )
    assert.ok(
      !requests.some((url) => /pubsdata\/Procedures\/en\/freq\.json$/i.test(url)),
      'the budget spent the fetch that no attempt would format against'
    )

    // and with the room for it, the next call finishes - one more file, no re-walk
    requests = []

    const formatted = await formatText(text)

    assert.equal(
      formatted,
      [
        'proc means data=work.foo;',
        '  var age;',
        'run;',
        '',
        'proc freq data=work.foo;',
        '  tables flag;',
        'run;',
        ''
      ].join('\n')
    )
    assert.equal(requests.length, 1, `expected the one missing file, got ${requests.join(', ')}`)
  }
)

run(
  'names the file when the host itself fails',
  async ({ formatText }) => {
    // CORS, DNS or a dropped connection: the runtime's own error carries no URL, so
    // the entry supplies it - and keeps the original as `cause`
    await assert.rejects(
      () => formatText(['data foo;', 'run;', ''].join('\n'), { dataRoot: '/broken' }),
      (error) => {
        assert.match(
          error.message,
          /^SAS language data could not be read: \/broken\/pubsdata\/procedures\.json: Failed to fetch$/
        )
        assert.ok(error.cause instanceof TypeError, 'the original error should be kept as cause')

        return true
      }
    )
  },
  { root: '/sas-language/', broken: '/broken/', timeout: 10_000 }
)

run(
  'names the file and the status when the data root does not answer',
  async ({ formatText }) => {
    // `assert.rejects` tests a RegExp against `String(error)`, which starts with
    // "Error: ", so the anchor is applied to the message itself
    await assert.rejects(
      () => formatText(['data foo;', 'run;', ''].join('\n'), { dataRoot: '/missing' }),
      (error) => {
        assert.match(
          error.message,
          /^SAS language data is missing: \/missing\/pubsdata\/procedures\.json answered 404/
        )

        return true
      }
    )
  },
  { root: '/missing/', refuse: 'pubsdata/procedures.json' }
)
