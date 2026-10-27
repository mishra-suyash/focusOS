# Sound credits

Every file here is public domain. Each `.m4a` is an AAC re-encode of the `.ogg` beside it, made
with macOS `afconvert`, for browsers that can't play Ogg Vorbis (Safari). Chosen by plan/18.

| File | Source | Original file | Licence |
|---|---|---|---|
| `session-end` | Kenney, *Music Jingles* — https://kenney.nl/assets/music-jingles | `Steel jingles/jingles_STEEL02.ogg` | CC0 1.0 |
| `break-end` | Kenney, *Music Jingles* | `Pizzicato jingles/jingles_PIZZI02.ogg` | CC0 1.0 |
| `heads-up` | Kenney, *Interface Sounds* — https://kenney.nl/assets/interface-sounds | `glass_001.ogg` | CC0 1.0 |
| `reminder` | Kenney, *Interface Sounds* | `drop_003.ogg` | CC0 1.0 |
| `block-closed` | Kenney, *Interface Sounds* | `confirmation_001.ogg` | CC0 1.0 |
| `noise-brown` | Wikimedia Commons — https://commons.wikimedia.org/wiki/File:Brownnoise.ogg | `Brownnoise.ogg` | Public domain (PD-ineligible) |
| `noise-grey` | Wikimedia Commons — https://commons.wikimedia.org/wiki/File:Gray_noise.ogg | `Gray_noise.ogg` | Public domain (PD-ineligible) |
| `noise-white` | Wikimedia Commons — https://commons.wikimedia.org/wiki/File:White_noise.ogg | `White_noise.ogg` | Public domain (PD-ineligible) |

Kenney asks for credit as a courtesy, though CC0 doesn't require it: thanks to Kenney (www.kenney.nl).

## Background-sound mixer (`scape/`)

Most loops come from two open-source ambient-sound apps whose sounds are curated for background
listening, not field recordings:

- [Blanket](https://github.com/rafaelmardojai/blanket) (GNOME): Freesound and SoundBible recordings,
  edited by Porrumentzio to Blanket's ambience loudness guidelines, each with its licence.
- [Moodist](https://github.com/remvze/moodist): sounds under CC0 or the Pixabay Content License. Both
  are free to use without attribution. Moodist doesn't record which applies to each sound, or its
  original source.

Each loop is a section of that file, trimmed, cross-faded into a seamless loop and level-matched
(about −27 dBFS RMS; fire and keyboard sit lower on purpose), then encoded to AAC. The CC BY ones
need credit, which the mixer's "Sound credits" list also gives.

| File | Original | Author | Licence | Via |
|---|---|---|---|---|
| `scape/rain.m4a` | [Rain](https://freesound.org/people/alex36917/sounds/524605/) | alex36917 | CC BY 4.0 | Blanket |
| `scape/heavy-rain.m4a` | Heavy Rain | unknown | CC0 or Pixabay Content License | Moodist |
| `scape/thunder.m4a` | [Storm](https://freesound.org/people/digifishmusic/sounds/41739/) | digifishmusic | CC BY 4.0 | Blanket |
| `scape/wind.m4a` | Wind in Trees | unknown | CC0 or Pixabay Content License | Moodist |
| `scape/birds.m4a` | [Birds](https://freesound.org/people/kvgarlic/sounds/156826/) | kvgarlic | CC0 | Blanket |
| `scape/waves.m4a` | [Waves](https://freesound.org/people/Luftrum/sounds/48412/) | Luftrum | CC BY 4.0 | Blanket |
| `scape/stream.m4a` | [Stream](https://freesound.org/people/gluckose/sounds/333987/) | gluckose | CC0 | Blanket |
| `scape/fire.m4a` | [Fireplace](https://soundbible.com/1543-Fireplace.html) | ezwa | Public domain | Blanket |
| `scape/cafe.m4a` | Cafe | unknown | CC0 or Pixabay Content License | Moodist |
| `scape/library.m4a` | [TU Delft Library, quiet study room - general ambience](https://commons.wikimedia.org/wiki/File:20121112_TU_Delft_Library,_quiet_study_room_-_general_ambience_-_SoundCloud_-_el_mar.ogg) (120–212 s) | el_mar | CC BY 3.0 | Wikimedia Commons |
| `scape/keyboard.m4a` | Keyboard | unknown | CC0 or Pixabay Content License | Moodist |
| `scape/train.m4a` | Inside a Train | unknown | CC0 or Pixabay Content License | Moodist |

The mixer's brown, grey and white noise are the `noise-*` files listed above.
