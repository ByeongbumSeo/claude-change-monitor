# change-monitor

[English](#english)

Claude Code에서 **이번 요청으로 바뀐 부분만** 보여주는 패널(Mod)입니다.

## 왜 만들었나

`git diff`는 마지막 커밋이 기준이라, 커밋 없이 요청을 여러 번 이어가면 A → A' → A''의 변경이 한데 섞여 "방금 요청에서 뭐가 바뀌었는지" 알기 어렵습니다.
change-monitor는 **Clear를 누른 시점**을 기준으로 Claude가 추가·수정·삭제한 파일과 diff를 보여줍니다. Clear → 요청 → 확인을 반복하면 요청 단위로 변경을 볼 수 있습니다.

## 설치

```
/plugin install change-monitor --marketplace ByeongbumSeo/claude-change-monitor
```

## 사용

- `/changes`: 패널 열기 / `/changes clear` 또는 패널의 **Clear**: 지금 상태를 새 기준으로
- 패널의 **Off**: 이 세션에서만 추적을 멈춥니다. 다시 켜려면 `/changes`
- 모든 세션에서 끄려면: `claude plugin disable change-monitor`
- Claude의 Edit·Write·Bash로 바뀐 파일을 추적합니다. 에디터 등 외부에서 고친 내용은 diff에서 제외합니다.

---

## English

A Claude Code pane (mod) that shows **only what the current request changed**.

**Why:** `git diff` compares against the last commit, so across several uncommitted requests (A → A' → A'') the changes pile up and you can't tell what the latest request did. change-monitor uses **the moment you press Clear** as its baseline and shows the files Claude added, modified or deleted since then, with diffs.

**Install:** `/plugin install change-monitor --marketplace ByeongbumSeo/claude-change-monitor`

**Use:** `/changes` opens the pane; `/changes clear` or the **Clear** button makes the current state the new baseline. **Off** stops tracking in this session only; `/changes` turns it back on. To turn it off in every session: `claude plugin disable change-monitor`. Tracks Claude's Edit, Write and Bash calls; edits made outside Claude are kept out of the diff.
