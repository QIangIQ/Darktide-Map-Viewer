# tools

Put `limn.exe` here. limn is a community tool that reads Darktide's bundle files; the extractor
(`pipeline/extract.py`) calls it as:

```
limn.exe -i <game>/bundle -o <cache>/raw --dump-raw <level|unit|material|texture>
limn.exe -i <game>/bundle -o <cache>/strings strings
limn.exe -i <game>/bundle -o <cache>/raw --dump-hashes *
```

It is not part of this repository. Use a build that supports these three commands.
