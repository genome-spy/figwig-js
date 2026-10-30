---
'@genome-spy/figwig': patch
---

Read remote Figwig files when CORS does not expose `Content-Range`. Physical-size
validation remains enabled when the size is known, and truncated reads are still
rejected.
