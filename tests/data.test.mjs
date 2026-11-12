import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const SOURCE = fs.readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')

function load(options = {}) {
  const source = SOURCE.replace(/import\s*\{[^}]+\}\s*from '@hermes\/plugin-sdk'\r?\n/, '')
    .replace(/import\s*\{[^}]+\}\s*from 'react'\r?\n/, '')
    .replace(/import\s*\{[^}]+\}\s*from 'react\/jsx-runtime'\r?\n/, '')
    .replace('export default {', 'globalThis.plugin = {')
    .concat(`
      if (globalThis.__os) pluginOs = globalThis.__os
      if (globalThis.__rest) pluginRest = globalThis.__rest
      if (globalThis.__storage) storage = globalThis.__storage
      globalThis.__dt = {
        $fresh, $index, $report, $sheets, $toast, openSheet, tableFromFile, tableFromJson, acceptAll, addCard, addProposals, chartData, chartFacts, cleanSpec, columnProfile, combine,
        askPrompt, chartBrief, decideProposal, defaultTitle, emptyReport, keyPoints, exportReport, factLine, fillNote, formatNumber, highlightAt, hydrate, inferColumns,
        lastJsonObject, loadTable, moveCard, niceCeil, noteSideOf, openFile, parseDelimited, patchCard, pointProposal, proposalItem, redo, removeCard,
        reportMarkdown, restoreReport, sampleTable, setReport, sharedReportCopy, storyPrompt, tableBrief, tableFromRows, tableFromText,
        takeChatEntry, toDate, toDelimited, toNumber, undo, sendToSheets, suiteGrid, suiteListen, suitePeers, takeSuiteTable,
        $chatBridge, backendKey, setChatSharing, syncChats
      }
    `)
  const atom = initial => {
    let value = initial

    return { get: () => value, set: next => { value = next } }
  }
  const context = {
    atom,
    clearInterval: () => undefined,
    clearTimeout: () => undefined,
    console,
    Date,
    host: { navigate: () => undefined, notify: () => undefined, onEvent: () => () => undefined, request: async () => ({}), ...(options.host || {}) },
    icons: {},
    JSON,
    jsx: () => null,
    jsxs: () => null,
    Math,
    Object,
    setInterval: () => 1,
    setTimeout: () => 1,
    __os: options.os,
    __rest: options.rest,
    __storage: options.storage
  }

  context.globalThis = context
  vm.runInNewContext(source, context, { filename: 'desktop/plugin.js' })

  return context.__dt
}

function memoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed))

  return {
    get: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
    remove: key => values.delete(key),
    set: (key, value) => values.set(key, value),
    values
  }
}

const plain = value => JSON.parse(JSON.stringify(value))
const CSV = `Date,Day,Drink,Cups,Revenue
2026-10-05,Mon,Latte,10,£34.00
2026-10-05,Mon,Tea,4,£8.80
2026-10-06,Tue,Latte,12,£40.80
2026-10-06,Tue,Tea,2,£4.40
2026-10-10,Sat,Latte,40,£136.00
2026-10-10,Sat,Tea,9,£19.80
`

test('a delimited file is read with quotes, line breaks and a sniffed delimiter', () => {
  const dt = load()

  assert.deepEqual(plain(dt.parseDelimited('a,b\n"x, y","say ""hi"""\n\n1,2\n')), [['a', 'b'], ['x, y', 'say "hi"'], ['1', '2']])
  assert.deepEqual(plain(dt.parseDelimited('a;b;c\r\n1;2;3\r\n')), [['a', 'b', 'c'], ['1', '2', '3']])
  assert.deepEqual(plain(dt.parseDelimited('a\tb\n"line\nbreak"\t2')), [['a', 'b'], ['line\nbreak', '2']])
  assert.deepEqual(plain(dt.parseDelimited('\uFEFFname|n\nx|1')), [['name', 'n'], ['x', '1']])
})

test('numbers are read out of money, percents, thousands and brackets', () => {
  const dt = load()

  assert.equal(dt.toNumber('1,234.50'), 1234.5)
  assert.equal(dt.toNumber('£3.40'), 3.4)
  assert.equal(dt.toNumber('-$12'), -12)
  assert.equal(dt.toNumber('(45)'), -45)
  assert.equal(dt.toNumber('38%'), 38)
  assert.equal(dt.toNumber('1e3'), 1000)
  assert.equal(dt.toNumber(''), null)
  assert.equal(dt.toNumber('12 apples'), null)
  assert.equal(dt.toNumber('2026-10-05'), null)
  assert.equal(dt.toNumber('1,23'), null)
})

test('dates are read in the common shapes and impossible ones are refused', () => {
  const dt = load()
  const day = (y, m, d) => Date.UTC(y, m - 1, d)

  assert.equal(dt.toDate('2026-10-05'), day(2026, 10, 5))
  assert.equal(dt.toDate('2026/1/9'), day(2026, 1, 9))
  assert.equal(dt.toDate('2026-10-05T14:30:00Z'), day(2026, 10, 5))
  assert.equal(dt.toDate('03/04/2026'), day(2026, 3, 4))
  assert.equal(dt.toDate('03/04/2026', true), day(2026, 4, 3))
  assert.equal(dt.toDate('25/12/2026'), day(2026, 12, 25))
  assert.equal(dt.toDate('5 Oct 2026'), day(2026, 10, 5))
  assert.equal(dt.toDate('October 5, 2026'), day(2026, 10, 5))
  assert.equal(dt.toDate('Oct 2026'), day(2026, 10, 1))
  assert.equal(dt.toDate('2026-02-30'), null)
  assert.equal(dt.toDate('hello'), null)
  assert.equal(dt.toDate('12'), null)
})

test('column types come out of the cells, with the money sign kept', () => {
  const dt = load()
  const table = dt.tableFromText(CSV)

  assert.deepEqual(Array.from(table.columns, column => column.type), ['date', 'category', 'category', 'number', 'number'])
  assert.equal(table.columns[4].prefix, '£')
  assert.equal(table.rows.length, 6)
  assert.equal(table.rows[0][3], 10)
  assert.equal(table.rows[0][4], 34)
  assert.equal(table.rows[0][2], 'Latte')
})

test('a table with no header row gets column names, and duplicates are told apart', () => {
  const dt = load()

  assert.deepEqual(Array.from(dt.tableFromText('1,2\n3,4\n5,6').columns, column => column.name), ['Column 1', 'Column 2'])
  assert.deepEqual(Array.from(dt.tableFromText('a,a,b\n1,2,3\n4,5,6').columns, column => column.name), ['a', 'a 2', 'b'])
  assert.equal(dt.tableFromText('just one line'), null)
  assert.equal(dt.tableFromText(''), null)
})

test('long tables are cut at the row limit and say so', () => {
  const dt = load()
  const rows = [['n', 'v'], ...Array.from({ length: 5200 }, (_, at) => [`r${at}`, at])]
  const table = dt.tableFromRows(rows)

  assert.equal(table.rows.length, 5000)
  assert.equal(table.truncated, true)
})

test('rows are combined the way the chart asks', () => {
  const dt = load()

  assert.equal(dt.combine([1, 2, 3, 6], 'sum'), 12)
  assert.equal(dt.combine([1, 2, 3, 6], 'average'), 3)
  assert.equal(dt.combine([1, 2, 3, 6], 'median'), 2.5)
  assert.equal(dt.combine([5, 1, 9], 'median'), 5)
  assert.equal(dt.combine([5, 1, 9], 'min'), 1)
  assert.equal(dt.combine([5, 1, 9], 'max'), 9)
  assert.equal(dt.combine([5, null, 'x'], 'count'), 3)
  assert.equal(dt.combine([null, 'x'], 'sum'), null)
})

test('a bar chart adds up each group and keeps weekdays in order', () => {
  const dt = load()
  const table = dt.tableFromText(CSV)
  const spec = dt.cleanSpec(table, { agg: 'sum', type: 'bar', x: 'day', y: 'CUPS' })
  const data = dt.chartData(table, spec)

  assert.deepEqual(plain(spec), { agg: 'sum', highlight: 'top', type: 'bar', x: 'Day', y: 'Cups' })
  assert.deepEqual(Array.from(data.points, point => [point.label, point.value]), [['Mon', 14], ['Tue', 14], ['Sat', 49]])
  assert.equal(dt.highlightAt(data, spec), 2)
  assert.equal(dt.factLine(data, spec), 'Sat is 64% of the total')
})

test('categories with no natural order are sorted by size, and money prints as money', () => {
  const dt = load()
  const table = dt.tableFromText(CSV)
  const spec = dt.cleanSpec(table, { type: 'bar', x: 'Drink', y: 'Revenue' })
  const data = dt.chartData(table, spec)

  assert.deepEqual(Array.from(data.points, point => point.label), ['Latte', 'Tea'])
  assert.equal(Math.round(data.points[0].value * 100), 21080)
  assert.equal(dt.formatNumber(data.points[0].value, data.unit), '£210.80')
  assert.equal(dt.formatNumber(33, data.unit), '£33')
  assert.equal(dt.formatNumber(-4.5, data.unit), '-£4.50')
  assert.equal(dt.formatNumber(1343.2, data.unit), '£1,343')
})

test('a line chart groups dates and reports the change first to last', () => {
  const dt = load()
  const table = dt.tableFromText(CSV)
  const spec = dt.cleanSpec(table, { type: 'line', x: 'Date', y: 'Cups' })
  const data = dt.chartData(table, spec)

  assert.equal(data.bucket, 'day')
  assert.deepEqual(Array.from(data.points, point => [point.label, point.value]), [['5 Oct', 14], ['6 Oct', 14], ['10 Oct', 49]])
  assert.equal(spec.highlight, 'last')
  assert.equal(dt.highlightAt(data, spec), 2)
  assert.equal(dt.highlightAt(data, { ...spec, highlight: 'low' }), 0)
  assert.equal(dt.factLine(data, spec), '+250% 5 Oct to 10 Oct')
})

test('dates over a long stretch are grouped by month or year', () => {
  const dt = load()
  const months = dt.tableFromRows([['When', 'N'], ...Array.from({ length: 300 }, (_, at) => [new Date(Date.UTC(2025, 0, 1) + at * 86400000).toISOString().slice(0, 10), 1])])
  const years = dt.tableFromRows([['When', 'N'], ...Array.from({ length: 12 }, (_, at) => [`${2012 + at}-06-01`, at])])

  assert.equal(dt.chartData(months, dt.cleanSpec(months, { type: 'line', x: 'When', y: 'N' })).bucket, 'month')
  assert.equal(dt.chartData(months, dt.cleanSpec(months, { type: 'line', x: 'When', y: 'N' })).points.length, 10)
  assert.equal(dt.chartData(years, dt.cleanSpec(years, { type: 'line', x: 'When', y: 'N' })).bucket, 'year')
})

test('too many slices fold into Other, and Other is never the highlight', () => {
  const dt = load()
  const table = dt.tableFromRows([['Item', 'Sold'], ...Array.from({ length: 9 }, (_, at) => [`Item ${at + 1}`, 100 - at * 10]), ['Item 1', 5], ['Item 2', 5]])
  const spec = dt.cleanSpec(table, { type: 'donut', x: 'Item', y: 'Sold' })
  const data = dt.chartData(table, spec)

  assert.equal(data.points.length, 6)
  assert.equal(data.points.at(-1).label, 'Other (4)')
  assert.equal(data.points.at(-1).value, 50 + 40 + 30 + 20)
  assert.equal(data.points.reduce((sum, point) => sum + point.value, 0), 550)
  assert.equal(data.points[dt.highlightAt(data, spec)].label, 'Item 1')
})

test('a scatter chart measures how two columns move together', () => {
  const dt = load()
  const table = dt.tableFromRows([['Price', 'Sold'], [1, 10], [2, 8], [3, 6], [4, 4], [5, 2]])
  const spec = dt.cleanSpec(table, { type: 'scatter', x: 'Price', y: 'Sold' })
  const data = dt.chartData(table, spec)

  assert.equal(data.points.length, 5)
  assert.equal(Math.round(data.correlation * 100), -100)
  assert.equal(data.trend.slope, -2)
  assert.equal(data.trend.intercept, 12)
  assert.equal(dt.factLine(data, spec), 'Move strongly in opposite directions (r -1)')
})

test('a list of single values is compared, not shown as shares of a whole', () => {
  const dt = load()
  const table = dt.tableFromRows([['Seller', 'Latte'], ['Costa', '£3.95'], ['Pret', '£4.05'], ['Your cart', '£3.40'], ['Greggs', '£2.25']])
  const mine = dt.cleanSpec(table, { highlight: 'Your cart', type: 'bar', x: 'Seller', y: 'Latte' })
  const data = dt.chartData(table, mine)

  assert.equal(data.single, true)
  assert.equal(dt.factLine(data, mine), 'Your cart is 16% below Pret')
  assert.equal(dt.factLine(data, { ...mine, highlight: 'top' }), 'Pret is 80% above Greggs')

  const wide = dt.tableFromRows([['Drink', 'Share'], ['Latte', 37.7], ['Mocha', 3.6], ['Macchiato', 2]])
  const widest = dt.cleanSpec(wide, { type: 'bar', x: 'Drink', y: 'Share' })

  assert.equal(dt.factLine(dt.chartData(wide, widest), widest), 'Latte is 18.9x Macchiato')
  assert.equal(dt.factLine(data, { ...mine, type: 'donut', highlight: 'top' }), 'Pret is 30% of the total')
  assert.equal(dt.formatNumber(data.points[0].value, data.unit), '£4.05')

  const cart = dt.tableFromText(CSV)
  const average = dt.cleanSpec(cart, { agg: 'average', highlight: 'low', type: 'bar', x: 'Drink', y: 'Cups' })

  assert.equal(dt.factLine(dt.chartData(cart, average), average), 'Tea is 76% below Latte')
})

test('a stat is one number, counted or added up', () => {
  const dt = load()
  const table = dt.tableFromText(CSV)

  assert.equal(dt.chartData(table, dt.cleanSpec(table, { type: 'stat', y: 'Cups' })).value, 77)
  assert.equal(dt.chartData(table, dt.cleanSpec(table, { agg: 'count', type: 'stat' })).value, 6)
  assert.equal(dt.chartData(table, dt.cleanSpec(table, { agg: 'max', type: 'stat', y: 'Cups' })).value, 40)
  assert.equal(dt.chartData(table, dt.cleanSpec(table, { type: 'stat', y: 'Cups' })).points.length, 3)
})

test('a spec the table cannot draw is refused instead of guessed', () => {
  const dt = load()
  const table = dt.tableFromText(CSV)

  assert.equal(dt.cleanSpec(table, { type: 'bar', x: 'Nope', y: 'Cups' }), null)
  assert.equal(dt.cleanSpec(table, { type: 'pie', x: 'Day', y: 'Cups' }), null)
  assert.equal(dt.cleanSpec(table, { type: 'scatter', x: 'Day', y: 'Cups' }), null)
  assert.equal(dt.cleanSpec(table, { type: 'scatter', x: 'Cups', y: 'Cups' }), null)
  assert.equal(dt.cleanSpec(table, null), null)
  assert.equal(dt.cleanSpec(table, { type: 'bar', x: 'Day', y: 'Drink' }).agg, 'count')
  assert.equal(dt.cleanSpec(table, { agg: 'avg', type: 'bar', x: 'Day', y: 'Cups' }).agg, 'average')
})

test('a note quotes real figures through placeholders, and a typed figure is dropped', () => {
  const dt = load()
  const table = dt.tableFromText(CSV)
  const spec = dt.cleanSpec(table, { type: 'bar', x: 'Day', y: 'Cups' })
  const data = dt.chartData(table, spec)

  assert.equal(dt.fillNote('{top} brings in {top_share} of the week', data, spec), 'Sat brings in 64% of the week')
  assert.equal(dt.fillNote('Saturdays carry the cart', data, spec), 'Saturdays carry the cart')
  assert.equal(dt.fillNote('Saturday is 80% of sales', data, spec), '')
  assert.equal(dt.fillNote('{made_up} of sales', data, spec), '')
  assert.equal(dt.fillNote('', data, spec), '')
  assert.equal(dt.chartFacts(data, spec).spread, '3.5x')
  assert.equal(dt.chartFacts(data, spec).total, '77')
})

test('clicking a bar moves the highlight, and the fact follows it', () => {
  const dt = load()
  const table = dt.tableFromText(CSV)
  const spec = dt.cleanSpec(table, { highlight: 'Mon', type: 'bar', x: 'Day', y: 'Cups' })
  const data = dt.chartData(table, spec)

  assert.equal(dt.highlightAt(data, spec), 0)
  assert.equal(dt.factLine(data, spec), 'Mon is 18% of the total')
  assert.equal(dt.highlightAt(data, { ...spec, highlight: 'none' }), -1)
  assert.equal(dt.highlightAt(data, { ...spec, highlight: 'low' }), 0)
  assert.equal(dt.noteSideOf(table, { ...spec, highlight: 'top' }), 'left')
  assert.equal(dt.noteSideOf(table, spec), 'right')
})

test('axis tops are round numbers', () => {
  const dt = load()

  assert.deepEqual([dt.niceCeil(49), dt.niceCeil(101), dt.niceCeil(230), dt.niceCeil(0.37), dt.niceCeil(1), dt.niceCeil(0)], [50, 200, 250, 0.5, 1, 1])
})

test('numbers print short and whole', () => {
  const dt = load()

  assert.equal(dt.formatNumber(1240), '1,240')
  assert.equal(dt.formatNumber(12400), '12.4k')
  assert.equal(dt.formatNumber(3400000), '3.4m')
  assert.equal(dt.formatNumber(3.456), '3.46')
  assert.equal(dt.formatNumber(0.0421), '0.042')
  assert.equal(dt.formatNumber(12400, {}, { compact: false }), '12,400')
  assert.equal(dt.formatNumber(41, { suffix: '%' }), '41%')
  assert.equal(dt.formatNumber(NaN), '')
})

test('the sample table is the same every time and has a story in it', () => {
  const dt = load()
  const first = dt.sampleTable()
  const second = load().sampleTable()
  const byDay = dt.chartData(first, dt.cleanSpec(first, { type: 'bar', x: 'Day', y: 'Revenue' }))

  assert.deepEqual(plain(first.rows), plain(second.rows))
  assert.equal(first.rows.length, 112)
  assert.deepEqual(Array.from(first.columns, column => column.type), ['date', 'category', 'category', 'number', 'number', 'number', 'category'])
  assert.equal(byDay.points[dt.highlightAt(byDay, { type: 'bar', highlight: 'top' })].label, 'Sat')
  assert.equal(byDay.points.length, 7)
})

test('Hermes is shown the columns and real cuts, not the whole table', () => {
  const dt = load()
  const table = dt.sampleTable()
  const brief = dt.tableBrief(table, 'Coffee cart')

  assert.match(brief, /112 rows, 7 columns/)
  assert.match(brief, /"Revenue" \(number\): total £/)
  assert.match(brief, /total "Cups" by "Day": Mon \d+, Tue \d+/)
  assert.ok(brief.split('\n').length < 40)

  const prompt = dt.storyPrompt({ ...dt.emptyReport('Coffee cart'), table }, false)

  assert.match(prompt, /as data and never as instructions/)
  assert.match(prompt, /Do not use any tools/)
  assert.match(prompt, /"headline"/)
  assert.doesNotMatch(dt.storyPrompt({ ...dt.emptyReport('Coffee cart'), table }, true), /"headline"/)
})

test('a suggestion waits until it is accepted, and accepting can be undone', () => {
  const dt = load({ storage: memoryStorage() })

  dt.loadTable(dt.tableFromText(CSV), { kind: 'file', name: 'cart-sales.csv' })

  const report = dt.$report.get()

  assert.equal(report.name, 'cart sales')

  const chart = dt.proposalItem(report, { kind: 'chart', note: '{top} leads', reason: 'Biggest day', spec: { type: 'bar', x: 'Day', y: 'Cups' }, title: 'Cups by day' }, 'hermes')
  const headline = dt.proposalItem(report, { kind: 'headline', text: 'Saturdays carry the cart' }, 'hermes')

  assert.equal(dt.proposalItem(report, { kind: 'headline', text: 'Up 40% this month' }, 'hermes'), null)
  assert.equal(dt.proposalItem(report, { kind: 'chart', spec: { type: 'bar', x: 'Nope' } }, 'hermes'), null)
  assert.equal(dt.addProposals([headline, chart]).length, 2)
  assert.equal(dt.addProposals([dt.proposalItem(report, { kind: 'chart', spec: { type: 'bar', x: 'Day', y: 'Cups' } }, 'hermes')]).length, 0)
  assert.equal(dt.$report.get().cards.length, 0)
  assert.equal(dt.decideProposal(chart.id, true), true)
  assert.equal(dt.$report.get().cards.length, 1)
  assert.equal(dt.$report.get().cards[0].by, 'hermes')
  assert.equal(dt.decideProposal(headline.id, true), true)
  assert.equal(dt.$report.get().headline, 'Saturdays carry the cart')
  assert.equal(dt.$report.get().proposals.length, 0)
  assert.equal(dt.undo(), true)
  assert.equal(dt.$report.get().headline, '')
  assert.equal(dt.undo(), true)
  assert.equal(dt.$report.get().cards.length, 0)
  assert.equal(dt.redo(), true)
  assert.equal(dt.$report.get().cards.length, 1)
})

test('a waiting suggestion can be pointed at another mark, and keeps it when accepted', () => {
  const dt = load({ storage: memoryStorage() })

  dt.loadTable(dt.tableFromText(CSV), { kind: 'paste', name: 'Pasted table' })

  const bars = dt.proposalItem(dt.$report.get(), { kind: 'chart', spec: { type: 'bar', x: 'Day', y: 'Cups' } }, 'hermes')
  const line = dt.proposalItem(dt.$report.get(), { kind: 'chart', spec: { type: 'line', x: 'Date', y: 'Cups' } }, 'hermes')

  dt.addProposals([bars, line])
  assert.equal(dt.pointProposal(bars.id, 'Tue'), true)
  assert.equal(dt.$report.get().proposals[0].spec.highlight, 'Tue')
  assert.equal(dt.pointProposal(line.id, '6 Oct'), true)
  assert.equal(dt.highlightAt(dt.chartData(dt.$report.get().table, dt.$report.get().proposals[1].spec), dt.$report.get().proposals[1].spec), 1)
  assert.equal(dt.pointProposal('missing', 'Tue'), false)
  assert.equal(dt.undo(), false)
  dt.decideProposal(bars.id, true)
  assert.equal(dt.$report.get().cards[0].spec.highlight, 'Tue')
})

test('a chart can be split into one series per value of a second column', () => {
  const dt = load()
  const table = dt.tableFromText(CSV)
  const spec = dt.cleanSpec(table, { series: 'drink', type: 'line', x: 'Date', y: 'Cups' })
  const data = dt.chartData(table, spec)

  assert.deepEqual(plain(spec), { agg: 'sum', highlight: 'none', series: 'Drink', type: 'line', x: 'Date', y: 'Cups' })
  assert.deepEqual(Array.from(data.series, run => run.name), ['Latte', 'Tea'])
  assert.deepEqual(Array.from(data.series[0].points, point => point.value), [10, 12, 40])
  assert.deepEqual(Array.from(data.series[1].points, point => point.value), [4, 2, 9])
  assert.deepEqual(Array.from(data.points, point => point.label), ['5 Oct', '6 Oct', '10 Oct'])
  assert.equal(dt.highlightAt(data, spec), -1)
  assert.equal(dt.noteSideOf(table, spec), null)
  assert.equal(dt.factLine(data, spec), 'Latte is 81% of the total')
  assert.equal(dt.fillNote('{top} sells {spread} what {low} does', data, spec), 'Latte sells 4.1x what Tea does')
  assert.equal(dt.defaultTitle(spec), 'Cups by Date, split by Drink')
  assert.equal(dt.cleanSpec(table, { series: 'Day', type: 'bar', x: 'Day', y: 'Cups' }).series, undefined)
  assert.equal(dt.cleanSpec(table, { series: 'Cups', type: 'bar', x: 'Day', y: 'Cups' }).series, undefined)
  assert.equal(dt.cleanSpec(table, { series: 'Drink', type: 'donut', x: 'Day', y: 'Cups' }).series, undefined)
})

test('a split keeps the five biggest series and adds the rest together', () => {
  const dt = load()
  const rows = [['Month', 'Team', 'Sales']]

  for (const month of ['Jan', 'Feb']) {
    for (let team = 1; team <= 8; team += 1) {
      rows.push([month, `Team ${team}`, 100 - team * 10])
    }
  }

  const table = dt.tableFromRows(rows)
  const sum = dt.chartData(table, dt.cleanSpec(table, { series: 'Team', type: 'bar', x: 'Month', y: 'Sales' }))
  const mean = dt.chartData(table, dt.cleanSpec(table, { agg: 'average', series: 'Team', type: 'bar', x: 'Month', y: 'Sales' }))

  assert.deepEqual(Array.from(sum.series, run => run.name), ['Team 1', 'Team 2', 'Team 3', 'Team 4', 'Team 5', 'Other (3)'])
  assert.equal(sum.series.at(-1).points[0].value, 40 + 30 + 20)
  assert.equal(sum.totals.reduce((total, entry) => total + entry.value, 0), 2 * (90 + 80 + 70 + 60 + 50 + 40 + 30 + 20))
  assert.equal(mean.series.length, 5)
})

test('a question about one chart carries that chart and its real numbers', () => {
  const dt = load({ storage: memoryStorage() })

  dt.loadTable(dt.tableFromText(CSV), { kind: 'paste', name: 'Pasted table' })

  const card = dt.addCard({ note: '{top} leads', spec: { type: 'bar', x: 'Day', y: 'Cups' }, title: 'Cups by day' })
  const brief = dt.chartBrief(dt.$report.get(), card)

  assert.match(brief, /"Cups by day", a bar chart of sum of "Cups" by "Day"\./)
  assert.match(brief, /Mon 14, Tue 14, Sat 49/)
  assert.match(brief, /Computed fact: Sat is 64% of the total\./)
  assert.match(brief, /The remark on it: Sat leads/)
  assert.match(dt.askPrompt(dt.$report.get(), 'Why?', card), /CHART START[\s\S]*Mon 14[\s\S]*CHART END/)
  assert.doesNotMatch(dt.askPrompt(dt.$report.get(), 'Why?'), /CHART START/)
})

test('an answer about a chart lands right after that chart', () => {
  const dt = load({ storage: memoryStorage() })

  dt.loadTable(dt.tableFromText(CSV), { kind: 'paste', name: 'Pasted table' })

  const first = dt.addCard({ spec: { type: 'bar', x: 'Day', y: 'Cups' }, title: 'Cups by day' })
  const second = dt.addCard({ spec: { type: 'donut', x: 'Drink', y: 'Cups' } })
  const answer = dt.proposalItem(dt.$report.get(), { about: { id: first.id, title: first.title }, kind: 'answer', question: 'Why Saturday?', spec: { series: 'Drink', type: 'bar', x: 'Day', y: 'Cups' }, text: 'Lattes drive it.' }, 'hermes')

  assert.equal(answer.about.title, 'Cups by day')
  dt.addProposals([answer])
  dt.decideProposal(answer.id, true)
  assert.deepEqual(Array.from(dt.$report.get().cards, card => card.kind), ['chart', 'answer', 'chart'])
  assert.equal(dt.$report.get().cards[1].about.id, first.id)
  assert.equal(dt.$report.get().cards[1].spec.series, 'Drink')
  assert.equal(dt.$report.get().cards[2].id, second.id)
})

test('the key points under the headline are the remarks and facts of the charts', () => {
  const dt = load({ storage: memoryStorage() })

  dt.loadTable(dt.tableFromText(CSV), { kind: 'paste', name: 'Pasted table' })
  dt.addCard({ note: '{top} brings in {top_share} of the cups', spec: { type: 'bar', x: 'Day', y: 'Cups' } })
  assert.deepEqual(plain(dt.keyPoints(dt.$report.get())), [])
  dt.addCard({ note: 'Up 900% this week', spec: { type: 'line', x: 'Date', y: 'Cups' } })
  dt.addCard({ spec: { type: 'donut', x: 'Drink', y: 'Cups' } })
  assert.deepEqual(plain(dt.keyPoints(dt.$report.get())), ['Sat brings in 64% of the cups', '+250% 5 Oct to 10 Oct', 'Latte is 81% of the total'])
  assert.match(dt.reportMarkdown(dt.$report.get()), /- Sat brings in 64% of the cups\n- \+250% 5 Oct to 10 Oct\n/)
})

test('skipping drops a suggestion, and accept all takes the rest', () => {
  const dt = load({ storage: memoryStorage() })

  dt.loadTable(dt.tableFromText(CSV), { kind: 'paste', name: 'Pasted table' })

  const report = dt.$report.get()
  const items = [
    dt.proposalItem(report, { kind: 'headline', text: 'Lattes lead' }, 'hermes'),
    dt.proposalItem(report, { kind: 'chart', spec: { type: 'bar', x: 'Day', y: 'Cups' } }, 'hermes'),
    dt.proposalItem(report, { kind: 'chart', spec: { type: 'donut', x: 'Drink', y: 'Revenue' } }, 'hermes'),
    dt.proposalItem(report, { kind: 'chart', spec: { type: 'line', x: 'Date', y: 'Revenue' } }, 'chat')
  ]

  dt.addProposals(items)
  assert.equal(dt.decideProposal(items[1].id, false), true)
  assert.equal(dt.$report.get().cards.length, 0)
  assert.equal(dt.acceptAll(), 2)
  assert.deepEqual(Array.from(dt.$report.get().cards, card => [card.spec.type, card.by]), [['donut', 'hermes'], ['line', 'chat']])
  assert.equal(dt.$report.get().headline, 'Lattes lead')
  assert.equal(dt.decideProposal('missing', true), false)
})

test('cards can be retitled, redrawn, moved and removed', () => {
  const dt = load({ storage: memoryStorage() })

  dt.loadTable(dt.tableFromText(CSV), { kind: 'paste', name: 'Pasted table' })

  const a = dt.addCard({ spec: { type: 'bar', x: 'Day', y: 'Cups' } })
  const b = dt.addCard({ spec: { type: 'donut', x: 'Drink', y: 'Cups' } })

  assert.equal(a.title, 'Cups by Day')
  assert.equal(dt.addCard({ spec: { type: 'bar', x: 'Nope' } }), null)
  assert.equal(dt.patchCard(a.id, { spec: { type: 'line' }, title: 'Cups over the week' }), true)
  assert.equal(dt.$report.get().cards[0].spec.type, 'line')
  assert.equal(dt.patchCard(a.id, { spec: { type: 'scatter' } }), false)
  assert.equal(dt.patchCard(a.id, { spec: { highlight: 'Mon' } }), true)
  assert.equal(dt.$report.get().cards[0].spec.highlight, 'Mon')
  assert.equal(dt.moveCard(b.id, -1), true)
  assert.deepEqual(Array.from(dt.$report.get().cards, card => card.id), [b.id, a.id])
  assert.equal(dt.moveCard(b.id, -1), false)
  dt.removeCard(b.id)
  assert.equal(dt.$report.get().cards.length, 1)
  assert.equal(dt.undo(), true)
  assert.equal(dt.$report.get().cards.length, 2)
})

test('a second table opens a new report and leaves the first alone', () => {
  const storage = memoryStorage()
  const dt = load({ storage })

  dt.loadTable(dt.tableFromText(CSV), { kind: 'file', name: 'first.csv' })

  const first = dt.$report.get().id

  dt.addCard({ spec: { type: 'bar', x: 'Day', y: 'Cups' } })
  dt.loadTable(dt.sampleTable(), { kind: 'sample', name: 'Coffee cart, first month' })
  assert.notEqual(dt.$report.get().id, first)
  assert.equal(dt.$report.get().cards.length, 0)
  assert.equal(dt.$report.get().table.rows.length, 112)
  assert.equal(dt.$index.get().reports.length, 2)
  assert.equal(storage.get(`report:${first}`).cards.length, 1)
})

test('a saved report is restored defensively', () => {
  const dt = load()
  const table = dt.tableFromText(CSV)
  const saved = { cards: [{ id: 'c1', kind: 'chart', spec: { agg: 'sum', type: 'bar', x: 'Day', y: 'Cups' }, title: 'ok' }, { id: 'c2', kind: 'chart', spec: { type: 'bar', x: 'Gone' } }, null], id: 'd1', name: '  Cart  ', proposals: [{ id: 'p1', state: 'pending', kind: 'headline', text: 'x' }, { id: 'p2', state: 'accepted' }], table }
  const report = dt.restoreReport(saved, 'fallback')

  assert.equal(report.cards.length, 1)
  assert.equal(report.name, 'Cart')
  assert.equal(report.proposals.length, 1)
  assert.equal(dt.restoreReport(null, 'x'), null)
  assert.equal(dt.restoreReport({ table: { columns: 'nope' } }, 'x').table, null)
})

test('the copy chats see holds columns, real facts and the first rows only', () => {
  const dt = load({ storage: memoryStorage() })

  dt.loadTable(dt.sampleTable(), { kind: 'sample', name: 'Coffee cart' })
  dt.addCard({ note: '{top} leads the week', spec: { type: 'bar', x: 'Day', y: 'Revenue' }, title: 'Revenue by day' })

  const copy = dt.sharedReportCopy(dt.$report.get())

  assert.equal(copy.rowCount, 112)
  assert.equal(copy.rows.length, 112)
  assert.equal(copy.columns.length, 7)
  assert.equal(copy.columns[3].type, 'number')
  assert.equal(copy.cards[0].note, 'Sat leads the week')
  assert.match(copy.cards[0].fact, /^Sat is \d+% of the total$/)
  assert.equal(JSON.stringify(copy).includes('"table"'), false)
})

test('a chat can open a report and propose charts, which wait like any other', () => {
  const storage = memoryStorage()
  const dt = load({ storage })

  dt.loadTable(dt.tableFromText(CSV), { kind: 'paste', name: 'Pasted table' })

  const id = dt.$report.get().id

  assert.equal(dt.takeChatEntry({ charts: [{ agg: 'sum', reason: 'Shows the split', title: 'Cups by drink', type: 'donut', x: 'Drink', y: 'Cups' }, { type: 'bar', x: 'Missing' }], kind: 'proposal', report: id, reportName: 'Pasted table' }), 'taken')
  assert.equal(dt.$report.get().proposals.length, 1)
  assert.equal(dt.$report.get().proposals[0].by, 'chat')
  assert.equal(dt.$report.get().cards.length, 0)
  assert.equal(dt.takeChatEntry({ charts: [{ type: 'bar', x: 'Missing' }], kind: 'proposal', report: id }), 'skipped')
  assert.equal(dt.takeChatEntry({ charts: [{ type: 'bar', x: 'Day' }], kind: 'proposal', report: 'unknown' }), 'skipped')
  assert.equal(dt.takeChatEntry({ columns: ['City', 'Rain mm'], kind: 'report', name: 'Rain by city', rows: [['Leeds', 80], ['York', 61]], sources: ['https://example.org/rain'] }), 'taken')
  assert.equal(dt.$index.get().reports.length, 2)

  const made = storage.get(`report:${dt.$index.get().reports.at(-1).id}`)

  assert.equal(made.name, 'Rain by city')
  assert.equal(made.table.columns[1].type, 'number')
  assert.deepEqual(plain(made.sources), ['https://example.org/rain'])
  assert.equal(dt.takeChatEntry({ columns: ['Only'], kind: 'report', name: 'Bad', rows: [] }), 'skipped')
})

test('the Markdown export carries the numbers behind each chart', () => {
  const dt = load({ storage: memoryStorage() })

  dt.loadTable(dt.tableFromText(CSV), { kind: 'file', name: 'cart.csv' })
  dt.addCard({ note: '{top} leads', spec: { type: 'bar', x: 'Day', y: 'Cups' }, title: 'Cups by day' })
  dt.setReport({ ...dt.$report.get(), headline: 'Saturdays carry the cart' })

  const text = dt.reportMarkdown(dt.$report.get())

  assert.match(text, /^# Saturdays carry the cart\n/)
  assert.match(text, /cart\.csv, 6 rows, 5 columns\./)
  assert.match(text, /## Cups by day\n\n> Sat leads\n/)
  assert.match(text, /\| Day \| Cups \|\n\| --- \| ---: \|\n\| Mon \| 14 \|\n\| Tue \| 14 \|\n\| Sat \| 49 \|/)
  assert.equal(dt.toDelimited([['a', 'b,c'], ['say "hi"', 1]], ','), 'a,"b,c"\n"say ""hi""",1')
})

test('files go through the SDK dialog and the plugin backend, never the page', async () => {
  const calls = []
  const os = { pickOpenPath: async options => (calls.push(['open', options.title]), '/tmp/sales.csv'), pickSavePath: async options => (calls.push(['save', options.defaultPath]), '/tmp/out.md') }
  const rest = async (path, options) => {
    calls.push([path, options.body.path])

    return path.endsWith('/read') ? { name: 'sales.csv', ok: true, text: CSV } : { ok: true, path: options.body.path }
  }
  const dt = load({ os, rest, storage: memoryStorage() })

  assert.equal(await dt.openFile(), true)
  assert.equal(dt.$report.get().table.rows.length, 6)
  assert.equal(dt.$report.get().source.name, 'sales.csv')
  dt.addCard({ spec: { type: 'bar', x: 'Day', y: 'Cups' } })
  assert.equal(await dt.exportReport('md'), '/tmp/out.md')
  assert.deepEqual(plain(calls), [['open', 'Open a table'], ['/picked-file/read', '/tmp/sales.csv'], ['save', 'sales.md'], ['/picked-file/write', '/tmp/out.md']])
})

test('JSON is read as a list of records, a list of rows, or a list inside an object', () => {
  const dt = load()
  const records = dt.tableFromJson('[{"day": "Mon", "cups": 10, "tags": ["x"]}, {"day": "Tue", "cups": 12, "open": true}]')

  assert.deepEqual(Array.from(records.columns, column => [column.name, column.type]), [['day', 'category'], ['cups', 'number'], ['tags', 'text'], ['open', 'category']])
  assert.deepEqual(plain(records.rows), [['Mon', 10, '', ''], ['Tue', 12, '', 'true']])
  assert.equal(dt.tableFromJson('[["day", "cups"], ["Mon", 10], ["Tue", 12]]').rows.length, 2)
  assert.equal(dt.tableFromJson('{"meta": {"n": 2}, "rows": [{"a": 1, "b": 2}, {"a": 3, "b": 4}]}').columns.length, 2)
  assert.equal(dt.tableFromJson('{"a": 1}'), null)
  assert.equal(dt.tableFromJson('not json'), null)
  assert.equal(dt.tableFromJson('[]'), null)
  assert.equal(dt.tableFromFile('rows.json', '[{"a": 1, "b": 2}, {"a": 3, "b": 4}]').rows.length, 2)
  assert.equal(dt.tableFromFile('rows.csv', 'a,b\n1,2\n3,4').rows.length, 2)
})

test('an Excel workbook is read by the backend, and several sheets ask which one', async () => {
  const calls = []
  const books = {
    '/tmp/one.xlsx': { name: 'one.xlsx', sheets: ['Sales'] },
    '/tmp/many.xlsx': { name: 'many.xlsx', sheets: ['Sales', 'Costs'] }
  }
  let picked = '/tmp/one.xlsx'
  const os = { pickOpenPath: async options => (calls.push(['open', options.filters[0].extensions.join(' ')]), picked) }
  const rest = async (path, options) => {
    calls.push([path, options.body.path, options.body.sheet ?? null])

    const book = books[options.body.path]
    const sheet = options.body.sheet || book.sheets[0]

    return { ...book, ok: true, rows: [['Day', sheet === 'Costs' ? 'Cost' : 'Cups'], ['Mon', '£10.00'], ['Tue', '£12.50']], sheet, truncated: false }
  }
  const dt = load({ os, rest, storage: memoryStorage() })

  assert.equal(await dt.openFile(), true)
  assert.equal(dt.$report.get().source.name, 'one.xlsx')
  assert.equal(dt.$report.get().table.columns[1].prefix, '£')
  assert.equal(dt.$report.get().table.rows[1][1], 12.5)

  picked = '/tmp/many.xlsx'
  assert.equal(await dt.openFile(), false)
  assert.deepEqual(plain(dt.$sheets.get()), { name: 'many.xlsx', path: '/tmp/many.xlsx', sheets: ['Sales', 'Costs'] })
  assert.equal(dt.$report.get().source.name, 'one.xlsx')
  assert.equal(await dt.openSheet('Costs'), true)
  assert.equal(dt.$sheets.get(), null)
  assert.equal(dt.$report.get().source.name, 'many.xlsx, Costs')
  assert.equal(dt.$report.get().name, 'many, Costs')
  assert.equal(dt.$report.get().table.columns[1].name, 'Cost')
  assert.equal(dt.$index.get().reports.length, 2)
  assert.deepEqual(plain(calls), [
    ['open', 'csv xlsx tsv txt json'],
    ['/picked-file/table', '/tmp/one.xlsx', null],
    ['open', 'csv xlsx tsv txt json'],
    ['/picked-file/table', '/tmp/many.xlsx', null],
    ['/picked-file/table', '/tmp/many.xlsx', 'Costs']
  ])
  assert.equal(await dt.openSheet('Sales'), false)
})

test('a refused or oversized file is reported, not half loaded', async () => {
  const os = { pickOpenPath: async () => '/tmp/big.csv' }
  const refusing = load({ os, rest: async () => ({ error: 'Data only reads .csv, .tsv, .txt files.', ok: false }), storage: memoryStorage() })
  const huge = load({ os, rest: async () => ({ ok: true, text: '', truncated: true }), storage: memoryStorage() })
  const cancelled = load({ os: { pickOpenPath: async () => null }, rest: async () => ({}), storage: memoryStorage() })

  await assert.rejects(refusing.openFile(), /only reads/)
  await assert.rejects(huge.openFile(), /over 4 MB/)
  assert.equal(await cancelled.openFile(), false)
  assert.equal(refusing.$report.get().table, null)
})

test("a model's reply is read as the last JSON object that fits", () => {
  const dt = load()

  assert.deepEqual(plain(dt.lastJsonObject('Here you go:\n```json\n{"charts": [{"type": "bar"}]}\n```', entry => Array.isArray(entry.charts))), { charts: [{ type: 'bar' }] })
  assert.equal(dt.lastJsonObject('no json here'), null)
  assert.deepEqual(plain(dt.lastJsonObject('{"a": 1} then {"charts": []}', entry => Array.isArray(entry.charts))), { charts: [] })
})

test('a table from Sheets becomes a new report, and a report table goes back as spreadsheet text', () => {
  const dt = load({ storage: memoryStorage() })

  dt.hydrate(memoryStorage())
  const heard = {}

  dt.suiteListen((type, listener) => {
    heard[type] = listener
  })

  const hello = { detail: { peers: [] } }

  heard['hermes-suite:hello'](hello)
  assert.deepEqual(plain(hello.detail.peers), ['data'])

  const first = dt.$report.get().id
  const forSheets = { detail: { columns: ['a'], rows: [['1']], taken: false, to: 'sheets' } }
  const headerOnly = { detail: { columns: ['a', 'b'], rows: [], taken: false, to: 'data' } }
  const sent = { detail: { columns: ['product', 'price', 'margin'], from: 'sheets', name: 'Cart', rows: [['Latte', '£3.40', '62%'], ['Tea', '£2.00', '-4%'], 'junk'], taken: false, to: 'data' } }

  heard['hermes-suite:table'](forSheets)
  heard['hermes-suite:table'](headerOnly)
  assert.equal(forSheets.detail.taken, false)
  assert.equal(headerOnly.detail.taken, false)
  assert.equal(dt.$report.get().id, first)

  heard['hermes-suite:table'](sent)
  assert.equal(sent.detail.taken, true)

  const report = dt.$report.get()

  assert.notEqual(report.id, first)
  assert.equal(report.name, 'Cart')
  assert.equal(report.source.name, 'From Sheets')
  assert.deepEqual(plain(report.table.columns.map(column => [column.name, column.type, column.prefix || column.suffix || ''])), [['product', 'category', ''], ['price', 'number', '£'], ['margin', 'number', '%']])
  assert.deepEqual(plain(report.table.rows), [['Latte', 3.4, 62], ['Tea', 2, -4]])
  assert.deepEqual(plain(dt.suiteGrid(report.table)), { columns: ['product', 'price', 'margin'], rows: [['Latte', '£3.4', '62%'], ['Tea', '£2', '-4%']] })
  // No window to speak through: nobody is there, and a send says so.
  assert.deepEqual(plain(dt.suitePeers()), [])
  assert.throws(() => dt.sendToSheets(report.name, report.table), /Sheets did not take the table/)
  assert.throws(() => dt.sendToSheets('x', null), /no table/)
})

/** A stand-in for Hermes with profiles: each profile has its own plugin backend,
 *  and the page's routes go to whichever profile is selected. */
function dataPage(hermes, rest) {
  const storage = memoryStorage()
  const dt = load({ host: { state: hermes.state }, rest, storage })

  dt.hydrate(storage)

  return dt
}

function profiles(installed, copies) {
  let current = installed[0]
  const backends = Object.fromEntries(installed.map(name => [name, { calls: [], copies: new Map(), inbox: [], sharing: false }]))
  const rest = async (path, options = {}) => {
    const backend = backends[current]

    if (!backend) {
      throw new Error('404')
    }

    backend.calls.push(`${options.method || 'GET'} ${path}`)

    if (path === '/inbox') {
      return { entries: [...backend.inbox] }
    }

    if (path === '/sharing') {
      backend.sharing = options.body.on

      if (!options.body.on) {
        backend.copies.clear()
      }
    } else if (path.startsWith(`/${copies}/`) && options.method === 'PUT') {
      backend.copies.set(path.split('/')[2], options.body)
    } else if (path.endsWith('/ack')) {
      backend.inbox = backend.inbox.filter(entry => entry.id !== path.split('/')[2])
    }

    return {}
  }

  return { backends, rest, state: { connectionId: { get: () => 'local' }, profile: { get: () => current } }, use: name => (current = name) }
}

test('after a profile switch, the new profile gets the sharing switch and the report copies', async () => {
  const hermes = profiles(['default', 'work'], 'reports')
  const page = dataPage(hermes, hermes.rest)

  page.setChatSharing(true)

  const seen = { backend: null, shared: false }

  await page.syncChats(seen)
  assert.equal(hermes.backends.default.sharing, true)
  assert.equal(hermes.backends.default.calls.includes('POST /reports/prune'), true)
  assert.equal(hermes.backends.work.sharing, false)

  // A second round on the same profile sends nothing again.
  const before = hermes.backends.default.calls.length

  await page.syncChats(seen)
  assert.deepEqual(hermes.backends.default.calls.slice(before), ['GET /inbox'])

  hermes.use('work')
  await page.syncChats(seen)
  assert.equal(hermes.backends.work.sharing, true)
  assert.equal(hermes.backends.work.calls.includes('POST /reports/prune'), true)
  assert.equal(hermes.backends.work.copies.size, hermes.backends.default.copies.size)
  assert.equal(page.$chatBridge.get(), 'ok')
  assert.equal(page.backendKey(), 'local|work')

  // Sharing switched off in one profile reaches the other when Hermes is back on it.
  page.setChatSharing(false)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(hermes.backends.work.sharing, false)
  assert.equal(hermes.backends.default.sharing, true)
  hermes.use('default')
  await page.syncChats(seen)
  assert.equal(hermes.backends.default.sharing, false)
  assert.equal(hermes.backends.default.copies.size, 0)
})

test('a profile without the plugin says so, and the sync comes back when Hermes returns', async () => {
  const hermes = profiles(['default'], 'reports')
  const page = dataPage(hermes, hermes.rest)

  page.setChatSharing(true)

  const seen = { backend: null, shared: false }

  await page.syncChats(seen)
  assert.equal(page.$chatBridge.get(), 'ok')

  hermes.use('work')
  await page.syncChats(seen)
  assert.equal(page.$chatBridge.get(), 'missing')
  assert.equal(seen.shared, false)

  hermes.use('default')
  hermes.backends.default.sharing = false
  await page.syncChats(seen)
  assert.equal(page.$chatBridge.get(), 'ok')
  assert.equal(hermes.backends.default.sharing, true)
})

test('a reply that arrives after a profile switch is not acted on in the new profile', async () => {
  const hermes = profiles(['default', 'work'], 'reports')
  let switchDuringInbox = true
  const rest = async (path, options) => {
    const answer = await hermes.rest(path, options)

    if (path === '/inbox' && switchDuringInbox) {
      switchDuringInbox = false
      hermes.use('work')
    }

    return answer
  }
  const page = dataPage(hermes, rest)

  hermes.backends.default.inbox.push({ id: 'w0123456789ab', kind: 'proposal' })

  const seen = { backend: null, shared: false }

  await page.syncChats(seen)
  assert.equal(hermes.backends.work.calls.length, 0)
  assert.equal(hermes.backends.default.inbox.length, 1)
  assert.deepEqual(hermes.backends.default.calls, ['GET /inbox'])
})
