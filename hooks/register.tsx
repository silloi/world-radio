import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RadioStatus, Station } from '../types'

const API =
  'https://de1.api.radio-browser.info/json/stations/search?hidebroken=true&limit=500&order=clickcount&reverse=true'
// Every player we start carries this in its argv, so pkill can always find it.
const MARK = 'world-radio-player'
const PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
// A player that dies sooner than this never really played: skip to another.
const MIN_LIFE_MS = 6000
const CONFIRM_MS = 4000
const MAX_SKIPS = 8
const LCD_FG = '#9dff6a'
const BEZEL = '#000000'

const station = atom({ plugin: 'world-radio', key: 'station' } as const, null)
const status = atom({ plugin: 'world-radio', key: 'status' } as const, 'stopped')
// The song on air, from the stream's ICY metadata; null until the station sends one.
const title = atom({ plugin: 'world-radio', key: 'title' } as const, null)

type $ = EngineInterface

export const flag = (cc: string): string =>
  /^[A-Za-z]{2}$/.test(cc)
    ? String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1f1e6 + c.charCodeAt(0) - 65))
    : '🌐'

let stations: Station[] = []
// What ▶▶ picks from: the world list, or one country's after `/radio jp`.
let pool: Station[] = []
let player: string | null = null
let gen = 0
let child: AsyncIterator<unknown> | null = null
// Stations we tuned away from, newest last, for the ◀◀ button.
let history: Station[] = []

// mpv prints a stream's song as ` icy-title: Artist - Song` under "File tags:".
export function icyTitle(line: string): string | null {
  const m = /^\s*icy-title:\s*(.*\S)\s*$/.exec(line)
  return m?.[1] ?? null
}

function setStatus(api: $, s: RadioStatus) {
  return update(api, status, () => s)
}

async function findPlayer(api: $): Promise<string | null> {
  for (const name of ['mpv', 'ffplay']) {
    try {
      const r = await api.process.run(['/usr/bin/which', name], { env: { PATH } })
      if (r.exitCode === 0 && r.stdout.trim()) return r.stdout.trim()
    } catch {}
  }
  return null
}

export function searchUrl(countrycode?: string): string {
  return countrycode ? `${API}&countrycode=${encodeURIComponent(countrycode)}` : API
}

async function fetchStations(api: $, countrycode?: string): Promise<Station[]> {
  const res = await api.http.fetch(searchUrl(countrycode), { headers: { 'User-Agent': 'world-radio/0.1' } })
  if (!res.ok) throw new Error(`radio-browser ${res.status}`)
  const list = JSON.parse(res.text) as {
    name?: string
    countrycode?: string
    url_resolved?: string
    geo_long?: number | null
  }[]
  return list
    .filter(s => s.url_resolved && s.name)
    .map(s => ({
      name: s.name!.trim(),
      countrycode: s.countrycode ?? '',
      url: s.url_resolved!,
      ...(typeof s.geo_long === 'number' ? { lng: s.geo_long } : {}),
    }))
}

async function loadStations(api: $): Promise<void> {
  if (stations.length === 0) stations = await fetchStations(api)
  if (pool.length === 0) pool = stations
}

async function stopPlayer(api: $): Promise<void> {
  gen++
  const c = child
  child = null
  try {
    await c?.return?.()
  } catch {}
  try {
    await api.process.run(['/usr/bin/pkill', '-f', MARK])
  } catch {}
}

function argvFor(bin: string, url: string): string[] {
  return bin.endsWith('ffplay')
    ? [bin, '-nodisp', '-autoexit', '-loglevel', 'error', '-window_title', MARK, url]
    : [bin, '--no-video', '--no-input-terminal', '--ytdl=no', '--network-timeout=8', `--title=${MARK}`, url]
}

async function play(api: $, s: Station, skips = 0): Promise<void> {
  await stopPlayer(api)
  const my = gen
  await update(api, station, () => s)
  await update(api, title, () => null)
  await setStatus(api, 'tuning')
  if (!player) player = await findPlayer(api)
  if (!player) {
    api.ui.toast('world-radio: install mpv (brew install mpv) or ffplay')
    await setStatus(api, 'error')
    return
  }
  const stream = api.process.spawn({ argv: argvFor(player, s.url), env: { PATH } })
  const it = stream[Symbol.asyncIterator]()
  child = it
  const startedAt = await api.clock.now()
  api.clock.after(CONFIRM_MS, () => {
    if (gen === my) void setStatus(api, 'playing')
  })
  void (async () => {
    let pending = ''
    try {
      for (let r = await it.next(); !r.done; r = await it.next()) {
        pending += (r.value as { text?: string }).text ?? ''
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) {
          const song = icyTitle(line)
          if (song && gen === my) await update(api, title, () => song)
        }
      }
    } catch {}
    if (gen !== my) return // we killed it on purpose
    child = null
    const lived = (await api.clock.now()) - startedAt
    if (lived < MIN_LIFE_MS && skips < MAX_SKIPS) {
      await playRandom(api, skips + 1)
    } else {
      await setStatus(api, lived < MIN_LIFE_MS ? 'error' : 'stopped')
    }
  })()
}

async function playRandom(api: $, skips = 0): Promise<void> {
  try {
    await setStatus(api, 'loading')
    await loadStations(api)
  } catch (err) {
    api.ui.toast(`world-radio: could not load stations (${String(err)})`)
    await setStatus(api, 'error')
    return
  }
  // A station that failed to play is not worth going back to.
  const prev = await read(api, station)
  if (skips === 0 && prev) history = [...history, prev].slice(-50)
  const s = pool[Math.floor(Math.random() * pool.length)]
  if (s) await play(api, s, skips)
}

async function back(api: $): Promise<void> {
  const prev = history[history.length - 1]
  if (!prev) {
    api.ui.toast('world-radio: no earlier station')
    return
  }
  history = history.slice(0, -1)
  await play(api, prev)
}

async function resume(api: $): Promise<void> {
  const s = await read(api, station)
  if (s) await play(api, s)
  else await playRandom(api)
}

async function stop(api: $): Promise<void> {
  await stopPlayer(api)
  await update(api, title, () => null)
  await setStatus(api, 'stopped')
}

// Run player work on a timer, outside any press dispatch, so it outlives it.
function later(api: $, fn: () => Promise<void>) {
  api.clock.after(1, () => void fn())
}

// Emoji and CJK are two cells wide; everything else here is one.
const cells = (s: string) => [...s].reduce((n, c) => n + ((c.codePointAt(0) ?? 0) > 0x2fff ? 2 : 1), 0)

export function fit(text: string, width: number): string {
  if (cells(text) <= width) return text
  let out = ''
  for (const c of text) {
    if (cells(out + c) > width - 1) break
    out += c
  }
  return out + '…'
}

const markOf = (st: RadioStatus) =>
  st === 'playing' ? '▶' : st === 'tuning' || st === 'loading' ? '◌' : st === 'error' ? '✕' : '■'

const nameOf = (s: Station | null, st: RadioStatus) =>
  st === 'loading' ? 'SCANNING THE WORLD' : s ? s.name.toUpperCase().replace(/\s+/g, ' ') : 'WORLD RADIO'

const iconOf = (s: Station | null, st: RadioStatus) => (s && st !== 'loading' ? flag(s.countrycode) : '📻')

// The terminal has no Svg: there the display is one line of text.
export function readout(s: Station | null, st: RadioStatus, width: number): string {
  const icon = iconOf(s, st)
  const mark = markOf(st)
  // "[ " + icon + " " + name + "  " + mark + " ]"
  const room = Math.max(4, width - cells(icon) - 9)
  const shown = fit(nameOf(s, st), room)
  return `[ ${icon} ${shown}${' '.repeat(room - cells(shown))}  ${mark} ]`
}

type LocaleZones = { getTimeZones?: () => string[]; timeZones?: string[] }

function offsetHours(zone: string, now: number): number {
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' })
      .formatToParts(now)
      .find(part => part.type === 'timeZoneName')?.value ?? 'GMT'
  const m = /GMT([+-])(\d+)(?::(\d+))?/.exec(name)
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) + Number(m[3] ?? 0) / 60) : 0
}

// The station's local time, HH:MM. Radio Browser has no time zone, so take the
// country's zones from Intl and, where it has several, the one nearest the
// station's longitude (15° an hour).
export function localTime(s: Station | null, now: number): string | null {
  if (!s || !/^[A-Za-z]{2}$/.test(s.countrycode)) return null
  let zones: string[] = []
  try {
    const loc = new Intl.Locale(`und-${s.countrycode.toUpperCase()}`) as unknown as LocaleZones
    zones = loc.getTimeZones?.() ?? loc.timeZones ?? []
  } catch {}
  let zone = zones[0]
  if (!zone) return null
  if (zones.length > 1 && s.lng !== undefined) {
    const want = s.lng / 15
    let best = Infinity
    for (const z of zones) {
      const d = Math.abs(offsetHours(z, now) - want)
      if (d < best) [best, zone] = [d, z]
    }
  }
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now)
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// The head unit's LCD, cropped to its bezel: the band itself is the chassis.
export function faceplate(
  s: Station | null,
  st: RadioStatus,
  channel: number,
  time: string | null,
  song: string | null = null,
): string {
  const isOn = st === 'playing'
  const isBusy = st === 'tuning' || st === 'loading'
  const name = esc(fit(nameOf(s, st), 25))
  const icon = iconOf(s, st)
  // The station's local time, its colon ticking like a car stereo clock.
  const [hh, mm] = time && st !== 'loading' ? time.split(':') : ['--', '--']
  const clock = `${hh}<tspan>:<animate attributeName="opacity" values="1;1;0.15;0.15" dur="1s" repeatCount="indefinite"/></tspan>${mm}`
  const blink = isBusy ? '<animate attributeName="opacity" values="1;0.15;1" dur="0.8s" repeatCount="indefinite"/>' : ''
  const stationLine = `<text x="22" y="60" class="lcd" filter="url(#glow)"><tspan font-size="20">${icon}</tspan> ${name}</text>`
  // Like RDS text: the station for 6s, then the song for 10s, a long song
  // scrolling through the slot left of the play mark. The desktop drops
  // clipPath, so the slot is a nested svg, and LCD-colored masks painted over
  // its sides keep the text off the clock even where that is dropped too.
  let line = stationLine
  if (song && st === 'playing') {
    const text = `♪ ${song.toUpperCase().replace(/\s+/g, ' ')}`
    const dx = Math.max(0, Math.ceil(cells(text) * 14.2 - 362))
    const phase = (on: boolean) =>
      `<animate attributeName="opacity" values="${on ? '0;1' : '1;0'}" keyTimes="0;0.375" calcMode="discrete" dur="16s" repeatCount="indefinite"/>`
    const scroll = dx
      ? `<animateTransform attributeName="transform" type="translate" values="0 0;0 0;-${dx} 0;-${dx} 0" keyTimes="0;0.45;0.9;1" dur="16s" repeatCount="indefinite"/>`
      : ''
    line = `<g>${phase(false)}${stationLine}</g>
  <g opacity="0">${phase(true)}<svg x="14" y="16" width="374" height="60" overflow="hidden"><text x="8" y="44" class="lcd" filter="url(#glow)">${esc(text)}${scroll}</text></svg></g>
  <rect x="0" y="36" width="12" height="40" fill="${BEZEL}"/>
  <rect x="388" y="36" width="156" height="40" fill="url(#lcd)"/>
  <rect x="544" y="36" width="12" height="40" fill="${BEZEL}"/>`
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="556" height="72" viewBox="0 10 556 72">
  <defs>
    <linearGradient id="lcd" gradientUnits="userSpaceOnUse" x1="0" y1="16" x2="0" y2="76">
      <stop offset="0" stop-color="#0a1808"/><stop offset="1" stop-color="#132a0e"/>
    </linearGradient>
    <pattern id="scan" width="3" height="3" patternUnits="userSpaceOnUse">
      <rect width="3" height="1" fill="#000" opacity="0.25"/>
    </pattern>
    <filter id="glow" x="-10%" y="-40%" width="120%" height="180%">
      <feGaussianBlur stdDeviation="1.6" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <style>
      .lcd { font: 700 22px ui-monospace, Menlo, monospace; fill: ${LCD_FG}; letter-spacing: 1px }
      .seg { font: 700 9px ui-monospace, Menlo, monospace; letter-spacing: 1px }
    </style>
  </defs>
  <rect x="8" y="12" width="540" height="68" rx="5" fill="${BEZEL}"/>
  <rect x="12" y="16" width="532" height="60" rx="3" fill="url(#lcd)"/>
  <text x="22" y="30" class="seg" fill="${isOn ? LCD_FG : '#2d5a20'}">ST</text>
  <text x="44" y="30" class="seg" fill="${LCD_FG}" opacity="0.8">CH ${channel > 0 ? String(channel).padStart(3, '0') : '---'}</text>
  <text x="100" y="30" class="seg" fill="${LCD_FG}" opacity="0.8">${s && st !== 'loading' ? esc(s.countrycode.toUpperCase() || '--') : '--'}</text>
  ${line}
  <text x="406" y="60" class="lcd" filter="url(#glow)">${markOf(st)}${blink}</text>
  <line x1="438" y1="22" x2="438" y2="70" stroke="${LCD_FG}" stroke-width="1" opacity="0.25"/>
  <text x="536" y="30" text-anchor="end" class="seg" fill="${LCD_FG}" opacity="0.6">LOCAL</text>
  <text x="536" y="60" text-anchor="end" class="lcd" filter="url(#glow)" opacity="${time ? 1 : 0.4}">${clock}</text>
  <rect x="12" y="16" width="532" height="60" rx="3" fill="url(#scan)"/>
</svg>`
}

// Each station shows a channel number on the display, its place in the list.
function channelOf(s: Station | null): number {
  if (!s) return 0
  const i = pool.findIndex(one => one.url === s.url)
  return i < 0 ? 0 : i + 1
}

// `/radio jp`: tune that country's stations; ▶▶ stays in it until `/radio all`.
async function tuneCountry(api: $, countrycode: string): Promise<void> {
  try {
    await setStatus(api, 'loading')
    const list = await fetchStations(api, countrycode)
    if (list.length === 0) {
      api.ui.toast(`world-radio: no stations for ${countrycode}`)
      await setStatus(api, 'stopped')
      return
    }
    pool = list
  } catch (err) {
    api.ui.toast(`world-radio: could not load stations (${String(err)})`)
    await setStatus(api, 'error')
    return
  }
  await playRandom(api)
}

async function tuneWorld(api: $): Promise<void> {
  pool = []
  await playRandom(api)
}

const USAGE = 'Usage: /radio [next|back|play|stop|all|<country code, e.g. jp>]'

async function radioCommand(api: $, args: string): Promise<string> {
  const word = args.trim().toLowerCase()
  if (word === 'next' || word === '') later(api, () => playRandom(api))
  else if (word === 'back' || word === 'prev') later(api, () => back(api))
  else if (word === 'stop') later(api, () => stop(api))
  else if (word === 'play') later(api, () => resume(api))
  else if (word === 'all' || word === 'world') later(api, () => tuneWorld(api))
  else if (/^[a-z]{2}$/.test(word)) {
    // ISO 3166 says GB; people say UK.
    const cc = word === 'uk' ? 'GB' : word.toUpperCase()
    later(api, () => tuneCountry(api, cc))
    return `📻 ${flag(cc)} ${cc}`
  } else return USAGE
  return `📻 ${word || 'next'}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // A reload or crash may have left a player running; start clean.
    await stopPlayer($)
    await setStatus($, 'stopped')
    await $.command.register({
      name: 'radio',
      description: 'World Radio: next, back, play, stop, or a country code (jp)',
      argumentHint: '[next|back|play|stop|all|jp]',
    })
    // The display's local time moves on; redraw it twice a minute.
    $.clock.every(30_000, () => $.ui.invalidate('ui.render'))
    // The list is the module's and a reload loses it; fetch it again so the
    // display's channel number comes back without waiting for a tune.
    later($, async () => {
      try {
        await loadStations($)
        $.ui.invalidate('ui.render')
      } catch {}
    })
    // Earlier versions drew in a side pane; close one left open.
    void $.ui.close({ id: 'world-radio' }).catch(() => {})
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await stopPlayer($)
    return next(e)
  })

  on('command.run', { command: 'radio' }, async ($, e) => ({ text: await radioCommand($, e.args) }))

  // While Claude works, the spinner says what is on air (not over tool steps).
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (e.props.mode === 'tool-use' || e.props.mode === 'tool-input') return next(e)
    const s = await read($, station)
    const st = await read($, status)
    if (!s || st !== 'playing') return next(e)
    const song = await read($, title)
    const word = song
      ? `📻 ${flag(s.countrycode)} ♪ ${fit(song, 40)}`
      : `📻 On air · ${flag(s.countrycode)} ${fit(nameOf(s, st), 28)}`
    return next({ ...e, props: { ...e.props, word, message: null } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const s = await read($, station)
    const st = await read($, status)
    const isOn = st === 'playing' || st === 'tuning' || st === 'loading'
    const { Box, Button, Text } = $.ui.resolve(e)
    // Primary buttons are dark caps with a light glyph: on the black bezel
    // they read as keys printed on the head unit (secondary ones vanish there).
    const key = (id: string, glyph: string, onPress: () => void) => (
      <Button key={id} label={glyph} variant="primary" onPress={onPress} />
    )
    const controls = (
      <Box gap={1} alignItems="center">
        {key('back', '◀◀', () => later($, () => back($)))}
        {isOn ? key('stop', '■', () => later($, () => stop($))) : key('play', '▶', () => later($, () => resume($)))}
        {key('next', '▶▶', () => later($, () => playRandom($)))}
      </Box>
    )

    if (e.surface === 'desktop') {
      const { Svg } = $.ui.resolve(e)
      // About 8px a column on the desktop; leave room for the keys.
      // The interactive frame has no height of its own, so give it one.
      const plate = Math.min(640, Math.max(300, e.props.bodyColumns * 8 - 190))
      return (
        // One black bezel holds the LCD and the keys, so they share its height;
        // the outer row keeps it from stretching across the band.
        <Box>
          <Box
            backgroundColor={BEZEL}
            borderStyle="round"
            borderColor={BEZEL}
            paddingRight={2}
            gap={2}
            alignItems="center"
          >
            <Svg
              source={faceplate(s, st, channelOf(s), localTime(s, await $.clock.now()), await read($, title))}
              alt={readout(s, st, 40)}
              width={plate}
              height={Math.round((plate * 72) / 556)}
              isInteractive
            />
            {controls}
          </Box>
        </Box>
      )
    }

    return (
      <Box gap={1}>
        <Text color={LCD_FG} bold>
          {readout(s, st, Math.min(44, Math.max(20, e.props.bodyColumns - 20)))}
        </Text>
        {controls}
      </Box>
    )
  })
}
