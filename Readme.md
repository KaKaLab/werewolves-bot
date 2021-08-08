# 狼人殺機器人
這是一個可以讓你和朋朋玩狼人殺的機器人！\
[🔗 Bot 邀請連結](https://discord.com/api/oauth2/authorize?client_id=872299329040310345&permissions=8&scope=applications.commands%20bot)

---

> 有了 Discord 的新 API，我們終於能更容易的做出可以玩狼人殺的機器人了！\
這個機器人運用了許多 [Interactions API](https://discord.com/developers/docs/interactions/message-components)，開局的部分更是運用了新的[討論串 API](https://discord.com/developers/docs/resources/channel#start-thread-with-message)，嘗試了將它們的特點好好的運用！

## 機器人指令
這個機器人的所有指令都是 `/wolf` 開頭的，裡面的指令清單也有做解釋，故此處只會講解 `/wolf settings ...` 內的選項。

* ### `roleMaxPlayers.[role]`
> 這些選項代表的是 `role` 角色的數量上限。其中：
> * `seer` 代表「預言家」，預設為 `1`。
> * `witch` 代表「女巫」，預設為 `1`。
> * `hunter` 代表「獵人」，預設為 `1`。
> * `knight` 代表「騎士」，預設為 `1`。
> * `werewolves` 代表「狼人」，預設為 `2`。

* ### `knightThreshold`
> 開始出現騎士所需要的玩家數量。預設為 `6`。

* ### `maxPlayers`
> 遊戲玩家的數量上限。預設為 `12`。

* ### `minPlayers`
> 遊戲玩家的數量下限，有這個數量的玩家加入就可以開始遊戲。預設為 `6`。

* ### `debugVoteOnly`
> 為了除錯用途而設計，值為 `true` 時只會進行投票。預設為 `false`。

* ### `debugShortTime`
> 為了除錯用途而設計，值為 `true` 時縮短投票與發言時間。預設為 `false`。

* ### `enableBeta`
> 啟用 Beta 功能， **Bug 出沒注意。** 預設為 `false`。

---

## 如何自己架設
在安裝之前需要先準備好以下事項：
 * 在 [Discord 開發人員網站](https://discord.com/developers/applications)建立好應用程式，之後為應用程式建立好 Bot 帳號。
 * [Node.js](https://nodejs.org/)

準備好之後就可以依下列步驟開始：

1. 打指令或從右邊下載，把這個 repo clone 下來：
```bat
git clone https://github.com/KakaLab/werewolves-bot
``` 

2. clone 好之後 (或是解壓縮之後) 會得到一個資料夾，裡面有以下檔案：
```txt
...
src/
package.json
Readme.md
tsconfig.json
```

3. 請在這裡打開終端機並輸入以下指令：
```bat
npm install
```

4. 在資料夾建立新的檔案 `config.json` 並填入以下設定：\
   (如果不確定的話可以先跳過，第 5 步做完就會看到這個檔案了)
```jsonc
{
    "token": "......"
}
```
> 這裡的 `token` 是要填入你在 Discord 開發人員網站那裡拿到的 Bot 機器人的**權杖 (token)** 喔！

5. 之後執行以下指令就可以啟動機器人囉！
```bat
npm run exec
```
> 你也可以把這段指令做成 script，之後打開機器人也許就不用這麼麻煩！
> 像是在 Windows 底下就可以做一個 `Start.bat`：
> ```bat
> @echo off
> npm run exec
> ```

> 如果第 4 步沒有完成，機器人會報錯！\
  所以填入正確的 token 是必要的！

---

## 機器人後臺指令
因為只有架設機器人的人才能碰到後臺，開發的時候 debug 很需要後臺給力支持，所以開發了一些功能方便機器人的主人使用！

* ### `announce`
```txt
> announce [訊息: string?]
```
> 這個指令可以用來在伺服器內發布訊息，主要是用來公告玩家「機器人準備要下線維護了」。

* ### `exit`
```txt
> exit
```
> 可以比較「優雅」的關閉機器人。

* ### `dump`
```txt
> dump <depth: number> <expr: string>
```
> `expr` 參數用法舉例： `$.games[0].players.map(v => v.member.user.tag)`

> ~~其實就是 `eval(...)`~~，是為了能在 debug 時候檢查數值、狀態所設的指令。\
> **>> 危險性極高，請謹慎使用 <<**

---

## 如何貢獻
我們真的是很努力對抗各種 Bug 才把它做出來的，我們也很歡迎你來幫我們解決 Bug！\
你可以自己 clone/fork 下來然後修改程式碼，如果有成功解決的話，歡迎來投 pull request！

## 參考資料
[Wikipedia](https://zh.wikipedia.org/wiki/狼人殺)