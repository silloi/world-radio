import { expect, mock, test } from 'claude-code/testing'

import { faceplate, flag, icyTitle, localTime, readout, searchUrl } from '../hooks/register'

test('country codes become flag emoji', async () => {
  expect(flag('jp')).toBe('🇯🇵')
  expect(flag('FR')).toBe('🇫🇷')
  expect(flag('')).toBe('🌐')
})

test('the readout is one upper-case line that fits the display', async () => {
  const kamakura = { name: 'Kamakura FM', countrycode: 'JP', url: 'x' }
  expect(readout(kamakura, 'playing', 30)).toMatch(/^\[ 🇯🇵 KAMAKURA FM +▶ \]$/)
  const long = { name: 'A Very Long Station Name That Goes On And On', countrycode: 'US', url: 'x' }
  expect(readout(long, 'stopped', 30)).toContain('…')
})

test('the faceplate escapes station names and shows the local time', async () => {
  const s = { name: 'Rock & <Roll> FM', countrycode: 'us', url: 'x' }
  const on = faceplate(s, 'playing', 42, localTime({ ...s, countrycode: 'jp' }, Date.UTC(2026, 0, 1, 3, 4)))
  expect(on).toContain('ROCK &amp; &lt;ROLL&gt; FM')
  expect(on).toContain('CH 042')
  expect(on).toContain('<animate')
  expect(on).toMatch(/12<tspan>:.*<\/tspan>04/)
  expect(faceplate(s, 'stopped', 42, null)).toContain('--<tspan>:')
})

test('the band draws the faceplate on desktop and a text display on the terminal', async ($, on) => {
  mock.clock(on)
  const props = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 }
  const desk = await $.ui.mount({ plugin: 'world-radio', surface: 'desktop', component: 'AbovePrompt', props })
  expect(await desk.find({ type: 'Svg' })).toBeDefined()
  for (const key of ['back', 'play', 'next']) expect(await desk.find({ key })).toBeDefined()
  await desk.unmount()
  const term = await $.ui.mount({ plugin: 'world-radio', surface: 'terminal', component: 'AbovePrompt', props })
  expect(await term.find({ type: 'Text', text: /WORLD RADIO/ })).toBeDefined()
  await term.unmount()
})

test('local time follows the country, and the longitude where it has several zones', async () => {
  const at = Date.UTC(2026, 0, 15, 12, 0)
  expect(localTime({ name: 'x', countrycode: 'JP', url: 'x' }, at)).toBe('21:00')
  expect(localTime({ name: 'x', countrycode: 'US', url: 'x', lng: -118.2 }, at)).toBe('04:00')
  expect(localTime({ name: 'x', countrycode: 'US', url: 'x', lng: -74 }, at)).toBe('07:00')
  expect(localTime({ name: 'x', countrycode: '', url: 'x' }, at)).toBeNull()
})

test('the song comes from mpv\'s icy-title line', async () => {
  expect(icyTitle(' icy-title: alt-J - Something Good')).toBe('alt-J - Something Good')
  expect(icyTitle('File tags:')).toBeNull()
  expect(icyTitle(' icy-title:   ')).toBeNull()
})

test('while a song is known the display alternates station and song, scrolling a long one', async () => {
  const s = { name: 'Radio Paradise', countrycode: 'US', url: 'x' }
  const short = faceplate(s, 'playing', 7, '12:00', 'alt-J - Something Good')
  expect(short).toContain('♪ ALT-J - SOMETHING GOOD')
  expect(short).toContain('calcMode="discrete"')
  expect(short).not.toContain('animateTransform')
  const long = faceplate(s, 'playing', 7, '12:00', 'The Very Long Artist Name - An Even Longer Song Title (Remastered)')
  expect(long).toContain('animateTransform')
  expect(faceplate(s, 'stopped', 7, '12:00', 'alt-J - Something Good')).not.toContain('♪')
  console.log('SVG-BEGIN' + long + 'SVG-END')
})

test('a country code narrows the station search', async () => {
  expect(searchUrl()).not.toContain('countrycode')
  expect(searchUrl('JP')).toMatch(/&countrycode=JP$/)
})
