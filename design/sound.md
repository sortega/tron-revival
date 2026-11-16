# Sound

The game has 17 short effects (`public/assets/sounds/*.mp3`) and no music, like the
original. The simulation never plays anything: it puts sound events in the frame
(`architecture.md`, "Simulation") and the game screen hands them to `SoundManager`.

## Why Web Audio

Until November 2026 every effect was an `HTMLAudioElement` cloned for each play. On phones
that loses sounds:

- iOS only lets an audio *element* start inside a touch or key handler. Sounds are played
  when a frame arrives, not inside a handler, so each new clone could be refused, and the
  refusal was swallowed.
- Every clone is a new media element that has to get its data again (from the cache at best)
  before it sounds: late or dropped when many start together (Uzi, shotgun, explosions).
- Phones limit how many media elements play at once.

So the effects are played with the Web Audio API instead:

- One `AudioContext` for the page. Each file is fetched once and decoded into an
  `AudioBuffer`; a play is a new `AudioBufferSourceNode` on that buffer, which costs nothing
  and can overlap freely. Everything goes through one gain node at 0.5.
- **Unlocking.** A context starts suspended until the user does something. The manager
  resumes it on every `pointerup`, `touchend`, `click` and `keydown` (capture phase, on
  `window`), and when the page becomes visible again. The listeners stay for the life of the
  page: iOS suspends the context again ("interrupted") after a call, the app switcher or a
  locked screen.
- While the context is not running, one-shot sounds are dropped, not queued: queued sources
  would all sound at once on resume. Loops are started anyway so that they are heard as soon
  as the context runs, and can be stopped by their key as usual.
- The same effect is not started twice within 25 ms (two players firing on the same tick
  would only make it louder).
- Where the browser has `navigator.audioSession` (Safari), its type is set to `playback`, so
  the iPhone's silent switch does not mute the game: that is how the audio elements behaved.
  The 🔊 button is the way to mute.
- A browser without `AudioContext` gets no sound.

## Interface

`play(name)`, `playLoop(name, key)`, `stopLoop(key)`, `stopAllLoops()`, `toggleMute()`,
`isMuted()`. The mute choice is kept in `localStorage` (`teratron-muted`). Muting stops the
loops and drops later sounds.

## Not done

- Pitch variation per shot and stereo position, as the original had
  (`research/gap-analysis.md`, G11): now cheap to add.
- Not yet checked on a real iPhone.
