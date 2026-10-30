# Large binary uploads

Selected files remain File/Blob references in the browser. Selection reads only
an initial 64 KiB probe. A Send snapshot preserves the selected handles across
script waits, re-selection and request navigation; no full-file Base64/JSON is
created. File bodies are sent to MiniPost in sequential, acknowledged chunks of
at most 1 MiB, then forwarded from anonymous temporary files in 64 KiB buffers.
Multipart uses the same file-backed path and a computed Content-Length.

The backend alone still encodes URL/form values. 307/308 redirects replay the
same staged file; 301/302/303 retain existing method-rewrite rules. No automatic
retry is made after an ambiguous transfer or target submission. Cancel removes
staging and interrupts a pending target socket; it cannot roll back a request
already received by the target. Errors, completion and idle expiry (15 minutes)
close temporary files. Anonymous files are also released when the process exits.

No fixed binary size limit is imposed. Sufficient temporary-disk capacity is
required; disk exhaustion is reported rather than reverting to an older file.
`MINIPOST_UPLOAD_DIR` optionally selects the temporary-file directory. The
backend and static assets must be updated together. Legacy JSON requests are
bounded at 64 MiB; new attachments do not travel through that JSON buffer.

`python -m unittest discover -s tests -p 'test_upload_stream.py'` covers framing,
exact bytes, redirect replay, incomplete chunks, cancellation and cleanup.
`python tests/large_upload_http.py` sends 384/512 MiB through a separately measured
proxy. `tests/ui_large_binary.py` is run by the existing Relay two-VM workflow;
it requires native Chromium, real HTTP, disk-backed files, receiver SHA-256,
bounded JavaScript/backend memory, cancellation and an explicit resend. It does
not use the inline DOM fixture or publish the large generated test files.
