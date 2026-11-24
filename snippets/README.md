# SAS function snippets

`functions.json` is adapted from `snippets/function-snippets.json` in the
[SAS extension for Visual Studio Code](https://github.com/sassoftware/vscode-sas-extension/blob/4adcfe1469e448eb28d0961be09d03cd120d4464/snippets/function-snippets.json),
Copyright (c) SAS Institute Inc., licensed under the Apache License, Version 2.0
(see [LICENSE.txt](LICENSE.txt)).

The source is pinned to commit `4adcfe1469e448eb28d0961be09d03cd120d4464`.
The local modifications add missing closing parentheses to `allperm` and `cos`,
and correct the fourth `compound` argument's snippet placeholder. Upstream
subsequently deleted the file in commit `c76adcf1775b42469d03f26a3146ff2a7fe62335`.
These snippets are maintained separately from the refreshed language data and
its upstream pin; they are not updated by the fetch or refresh scripts.
