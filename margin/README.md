# Margin — e-book reader

Margin is an installable, offline e-book reader. It is a Progressive Web App (PWA): one set of
static files that installs as a standalone app on Windows, macOS, Linux, ChromeOS, Android,
iPhone and iPad. There is no build step and no server; everything stays on your device.

**Formats:** EPUB 2/3, PDF, MOBI, AZW3 (KF8), FB2, Word (.docx), comics (CBZ, CBR, CB7, CBT) and plain text, all DRM-free.
**Audiobooks:** M4B, M4A, MP3, Opus, Ogg, FLAC, WAV and AAC. Use one file, all of a book's files selected together, or a .zip of them.

## 1. Put it online (required to install)

Browsers only install apps served over **HTTPS**. Any static host works:

- **Netlify Drop:** go to https://app.netlify.com/drop and drag the `margin-reader` folder in.
- **GitHub Pages:** push the folder to a repo, then turn on *Settings → Pages* (deploy from the branch root). `.nojekyll` is included.
- **Cloudflare Pages / Vercel:** create a project from the folder. No build command, output directory `/`.

Relative paths are used throughout, so a sub-path such as `https://you.github.io/margin-reader/` works too.

To try it locally (`localhost` counts as secure, so installing works there too):

```bash
cd margin-reader
```

```bash
python3 -m http.server 8080
```

Then open http://localhost:8080.

## 2. Install it

| Platform | How |
| --- | --- |
| Windows, macOS, Linux, ChromeOS (Chrome or Edge) | **Install** button in Margin's library, or the install icon in the address bar |
| macOS (Safari 17+) | *File → Add to Dock* |
| Android (Chrome) | **Install** button, or menu → *Install app* |
| iPhone / iPad (Safari) | Share → *Add to Home Screen* (Margin shows this hint on iOS) |
| Firefox (desktop) | Firefox doesn't install web apps; Margin still works in a tab |

## Features

**Reading**
- Printed-book layout: two-page spreads, running heads, page numbers, drop caps; pages slide when turned. Or continuous scrolling.
- PDFs and comics open in a page viewer with one or two pages, pinch / double-click / Ctrl+scroll zoom, outline, page thumbnails and (for PDFs) text search. **Text view** reflows a PDF so highlights, themes and read-aloud work on it.
- Typefaces: Literata, Newsreader, Atkinson Hyperlegible, Figtree, OpenDyslexic. Size, line spacing, letter and word spacing, margins, justification.
- Themes: Auto, Paper, Sepia, Dusk, Night, plus a night-light warmth filter.
- Focus aids: reading ruler (follows the pointer or finger; ↑/↓ moves it a line), bold word starts ("bionic"), dim all but the current paragraph.
- Auto-advance: turns pages or scrolls at a words-per-minute speed you set.
- Read aloud with the device's voices, sentence highlighting and lock-screen/media-key controls.
- Footnotes open in a popover; images open full-screen with pinch and zoom.
- Keyboard shortcuts: press `?` while reading.

**Audiobooks**
- A player with the cover, current chapter and its progress, back 15 s and forward 30 s, previous and next chapter, speed from 0.75× to 3×, a sleep timer (5–60 minutes or the end of the chapter, with a gentle fade-out) and bookmarks.
- Chapters are read from the file: M4B/M4A (Nero and QuickTime chapter formats), MP3 (ID3 CHAP) and Ogg/FLAC (CHAPTERxx tags). For a multi-file book each file becomes a chapter, ordered by track number. Title, author and cover come from the tags, or from a cover image in the .zip.
- Your place is saved as you listen. Listening keeps going while you browse the library, with a now-playing bar. Lock-screen, headphone and media-key controls work, and listening time counts towards your goals and stats.
- Keyboard: Space plays and pauses, ←/→ skip 15 s back or 30 s forward, Shift+←/→ change chapter, +/− change speed, B adds a bookmark, T shows the chapters.
- **Discover → LibriVox audiobooks:** browse and search thousands of free public-domain audiobooks read by volunteers, and download them straight into your library.
- Playback uses the browser's own audio support. Chrome, Edge, Safari and the Windows app play M4B, M4A and MP3. Firefox plays MP3, Opus and FLAC, but M4B only where the system provides AAC support.

**Words**
- Offline English dictionary (WordNet 3.1, 147,000 words with examples and synonyms). It downloads once (about 5 MB) on your first lookup and then works offline.
- *Add to Words* saves the word with the sentence you found it in. The **Words** tab reviews them as flashcards on a spaced-repetition schedule (Leitner boxes).
- Translate any selection. Recent Chrome and Edge translate on the device; elsewhere Margin offers a Google Translate link.

**Notes**
- Highlights in five colours, notes, bookmarks.
- The **Highlights** tab searches every highlight in every book, filters by colour or notes, and opens each one in context.
- Export as Markdown, Obsidian (YAML front matter and quote callouts; a zip with one note per book), Readwise CSV (import at readwise.io/import_bulk) or Notion CSV (import as a database).
- Quote cards: turn any passage into a 1080×1350 image in the book's colour, then share or save it.

**Library**
- **Removing books:** use *Remove from library…* in a book's ⋯ menu, in *Book details*, or in the reader's side panel (⋯), or press Delete on a selected book. To remove several at once, use **Select**. You're told exactly what goes with the book (highlights, notes, bookmarks, position), and **Undo** brings it all back for 10 seconds. The sample book can be removed and restored.
- Shelves: Reading, To read, Finished, plus your own. Tags (search `#tag`). Edit a book's title, author and cover.
- **Insights:** a daily minutes goal and a yearly books goal with progress rings, an optional daily reminder, a 14-day chart, reading speed, and **Year in review** (books finished, hours, days read, longest streak, biggest month, favourite highlights).
- **Discover — recent books:**
  - **Open-access books (recent):** nonfiction and academic books from the last few years that publishers and universities release free under Creative Commons licences, with subject buttons, *Most read* or *Newest* order, and a date range. Results come from OpenAlex, which indexes OAPEN, DOAB and publishers such as Cambridge, Oxford and Routledge. Only books with a free download are shown; a few publishers hand the file out only on their own site, and Margin then offers the publisher's page.
  - **Open textbooks:** current, peer-reviewed college and university textbooks from OpenStax at Rice University, by subject.
  - **Gutenberg → Recently added** lists the newest additions first, including books that entered the public domain this year.
  - Recent bestsellers are still under copyright, so they can't be offered free. Library loans (Libby, Open Library) are copy-protected and only open in their own apps.
- **Discover:** search and browse 70,000+ free books from Project Gutenberg by subject. Religion, Science and Technology have subcategories: Christianity, Islam and other religions (Judaism, Buddhism, Hinduism, Taoism, Confucianism, Zoroastrianism); Physics, Chemistry, Biology & nature, Astronomy, Mathematics, Earth sciences, Medicine & health (science fiction is left out of Science); and Engineering, Electricity & radio, Inventions, Transport, Industry & manufacturing, Building & architecture, Agriculture, Computing, or add any OPDS catalog (your Calibre library, Kavita, Komga, a public library feed).

**Your data**
- **Backup & restore:** one `.margin` file holds your books and audiobooks, positions, highlights, notes, bookmarks, words, shelves, goals and stats. Restoring on another device merges with what's there: nothing is overwritten, newer positions win, and highlights are combined.
- **Open with Margin** (desktop Chrome/Edge) and **Share to Margin** (Android) for all supported formats.

## The download relay (optional)

Some sites, including gutenberg.org for book files and LibriVox, don't let web apps download directly. Margin
handles this in three steps: it tries the site directly, then your relay if you've set one up, and
otherwise it shows a **Download file** link so you can save the book and drop it into Margin.

To download straight into Margin, deploy the relay. It's free and takes about two minutes:

1. Sign in at https://dash.cloudflare.com → *Workers & Pages* → *Create* → *Create Worker* → *Deploy*.
2. *Edit code*, replace everything with the contents of `relay/worker.js`, and click *Deploy*.
3. Copy the worker address (`https://….workers.dev`) into Margin → **Discover** → **Download relay**.

The relay only fetches from the hosts listed in `ALLOWED_HOSTS` (add your own OPDS servers there).
Set `ALLOW_ORIGIN` to your Margin address so other sites can't use it.

## Folder contents

| Path | Purpose |
| --- | --- |
| `index.html`, `css/app.css` | App structure and visual system |
| `js/app.js` | Reader, settings, read-aloud, reading aids, wiring |
| `js/parse.js`, `js/formats.js` | EPUB/TXT parsing; MOBI/AZW3/FB2/DOCX conversion, PDF and comic loading |
| `js/fixed.js` | Page viewer for PDFs and comics |
| `js/extras.js` | Shelves, details, goals, insights, highlights, exports, flashcards, quote cards, backup UI |
| `js/discover.js`, `relay/worker.js` | Gutenberg/OPDS browser and the optional relay |
| `js/dict.js`, `vendor/wordnet.json.gz` | Dictionary, vocabulary, translation |
| `js/backup.js` | Backup file format and merge logic |
| `vendor/` | JSZip, pdf.js (Mozilla), foliate-js MOBI/FB2 parsers, libarchive.js (RAR/7z), mammoth (DOCX) |
| `fonts/`, `icons/` | Bundled fonts and app icons |
| `manifest.webmanifest`, `sw.js` | Install metadata, offline cache, file handling, share target |

After changing any file, bump `VERSION` in `sw.js` so installed copies update.

## App stores (optional)

Enter your hosted URL at https://www.pwabuilder.com to generate Microsoft Store (MSIX), Google Play
(Trusted Web Activity) and Apple App Store (Xcode project; needs a Mac and a developer account) packages.

## Limits

- **DRM:** books bought from Kindle, Apple Books, Kobo and similar stores are encrypted and can't be opened.
- **No automatic sync between devices.** That needs a server; use backup and restore to move everything across.
- **Reminders** fire only while Margin is open or in a background tab. Browsers can't wake a closed web app on a schedule.
- **PDFs:** text view works well for ordinary books. Multi-column, scanned (image-only) or heavily designed PDFs reflow poorly; use page view for those.
- **On-device translation** needs a recent Chrome or Edge; other browsers get a Google Translate link.

## Licences

Margin's own code is yours to use. Bundled components keep their licences (see each `vendor/` folder):
pdf.js (Apache 2.0), foliate-js (MIT), libarchive.js (MIT; libarchive BSD), mammoth (BSD-2),
JSZip (MIT), WordNet 3.1 (WordNet licence, `vendor/WORDNET-LICENSE`), fonts (SIL Open Font License).
The sample *Pride and Prejudice* chapters are public domain.
