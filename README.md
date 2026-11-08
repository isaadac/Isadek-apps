# Isadek apps — website

This branch is published with GitHub Pages. It is separate from `main`, which holds the
Isadek OS app list (`apps.tsv`), so nothing here affects Isadek OS.

| Address | What |
| --- | --- |
| `https://isaadac.github.io/isadek-apps/margin/` | **Margin**, the offline e-book and audiobook reader (installable as an app) |

To update Margin, replace the `margin/` folder with the new version and commit. After changing
files, bump `VERSION` in `margin/sw.js` so installed copies update.
