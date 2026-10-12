# Third-party notices

Knowledge Seed is new MIT-licensed code. It does not incorporate source code from Karpathy LLM Wiki, Poneglyph, Smart Connections, Juggl, Semantic Canvas or ExcaliBrain; those projects were evaluated as functional baselines only.

The distributable bundles Defuddle 0.19.4 (MIT), the page-content extraction library also used by Obsidian Web Clipper, and its runtime dependency mathml-to-latex (MIT). Full installed license texts are copied into DEPENDENCY-LICENSES.txt when packaging. Source: https://github.com/kepano/defuddle and the installed dependency packages.

Obsidian is a separately installed host application; its API types are a development dependency, excluded from the bundle. The JSON Canvas format is implemented using its public 1.0 specification: https://jsoncanvas.org/spec/1.0/ . No private graph-renderer code is used.

Web content retains its original ownership and license. Generated source notes retain source URLs and retrieval timestamps. Wikimedia content may have additional attribution/share-alike obligations when reused or distributed; check the linked source page. Tests include clearly marked synthetic examples and three unmodified Wikipedia HTML snapshots. These snapshots are not covered by the plugin's MIT license; source attribution and the applicable source license are recorded in tests/fixtures/NOTICE.md and docs/parsing-quality.md. The snapshots are included only in the source archive, not in the runtime plugin.
