# world-radio

A retro car-stereo radio for Claude Code. A green LCD display with ◀◀ ▶/■ ▶▶ keys sits in the band above the prompt, and plays random stations from around the world while you work.

- **▶▶** jumps to a random station from the 500 most popular on [Radio Browser](https://www.radio-browser.info/)
- **◀◀** goes back to the previous station, **▶ / ■** plays and stops
- The display shows the country's flag, the station name, and the station's **local time**
- When a station sends the song on air (ICY metadata), the display alternates between the station and `♪ ARTIST - SONG`, scrolling long titles
- While Claude works, its status line reads `📻 On air · 🇧🇷 RADIO GLOBO`
- Stations that fail to play are skipped automatically

## Requirements

- [mpv](https://mpv.io/) (or `ffplay` from FFmpeg) on your `PATH`:

  ```bash
  brew install mpv
  ```

- The Claude Code desktop app (Code tab) draws the car stereo. A terminal session shows a one-line text display with the same keys.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install world-radio --marketplace silloi/world-radio
```

Answer `y` to add the marketplace, then pick the user scope. A local session the desktop app starts loads it too.

## Commands

| Command | What it does |
| --- | --- |
| `/radio` or `/radio next` | Tune a random station |
| `/radio back` | Back to the previous station |
| `/radio play` / `/radio stop` | Play or stop |
| `/radio jp` | Tune stations from one country (any ISO country code; `uk` works too). ▶▶ stays in that country |
| `/radio all` | Back to stations from the whole world |

## Notes

- The station's local time comes from its country code; for countries with several time zones, the zone nearest the station's longitude is used.
- Playback runs `mpv` in the background. Stopping, switching stations, ending the session, or reloading the plugin kills it.

## License

MIT
