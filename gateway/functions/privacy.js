export const PRIVACY_POLICY_HTML = `<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>玄澈引擎 Gateway 隱私權政策</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.7; }
      body { margin: 0 auto; max-width: 54rem; padding: 2rem 1.25rem 4rem; }
      h1, h2 { line-height: 1.3; }
      h2 { margin-top: 2rem; }
      code { background: color-mix(in srgb, currentColor 10%, transparent); padding: 0.1rem 0.3rem; }
      .updated { opacity: 0.75; }
    </style>
  </head>
  <body>
    <main>
      <h1>玄澈引擎 Gateway 隱私權政策</h1>
      <p class="updated">最後更新：2026 年 7 月 16 日</p>

      <h2>一、適用範圍</h2>
      <p>本政策適用於 <code>xuanche-engine-gateway.pages.dev</code> 提供的 Custom GPT Action Gateway 與其 API。Gateway 透過 Cloudflare 處理請求，並依使用者授權連接指定的 Notion 與 GitHub 資源。</p>

      <h2>二、處理的資料</h2>
      <ul>
        <li><strong>驗證資料：</strong><code>X-API-Key</code> 僅用於驗證 API 請求。Gateway 程式不會把完整 API Key 寫入回應、Notion、GitHub 或 KV，也不主動記錄完整請求標頭。</li>
        <li><strong>Action 請求資料：</strong>可能包含頁面或區塊 ID、讀取參數、玩家明確要求寫入的文字與 Notion 區塊內容。</li>
        <li><strong>整合資料：</strong>依 Action 讀取或修改獲授權的 Notion 內容；公開 GPT Action Schema 對 GitHub 僅提供儲存庫樹與單一檔案的唯讀存取。</li>
        <li><strong>技術資料：</strong>Cloudflare 可能依服務設定處理 IP 位址、時間、路徑、狀態碼與安全或診斷紀錄。</li>
      </ul>

      <h2>三、處理目的</h2>
      <p>資料只用於驗證請求、逐頁載入遊戲規則與存檔、執行使用者要求的細粒度 Notion 寫入、讀取 GitHub 長期記憶，以及維護服務安全、可靠性與錯誤診斷。</p>

      <h2>四、第三方服務</h2>
      <ul>
        <li><strong>Cloudflare：</strong>代管 Pages Gateway、Worker、Service Binding，並可能提供 KV、日誌與安全防護。</li>
        <li><strong>Notion：</strong>保存並處理使用者授權的世界設定、存檔與頁面內容。</li>
        <li><strong>GitHub：</strong>保存並處理設定的儲存庫內容；公開 GPT Actions 僅暴露唯讀操作。</li>
        <li><strong>OpenAI／ChatGPT：</strong>Custom GPT 會將執行 Action 所需的參數傳送至本 Gateway；OpenAI 自身的資料處理由其政策規範。</li>
      </ul>

      <h2>五、資料出售與廣告</h2>
      <p>本服務不出售個人資料，也不使用 Action 資料進行跨服務追蹤、行為廣告或資料仲介。</p>

      <h2>六、保存與刪除</h2>
      <p>Gateway 本身不建立獨立的使用者帳號資料庫。Notion 與 GitHub 內容依各服務及儲存庫設定保存；Worker 後端可能依設定使用 Cloudflare KV 快照或操作紀錄。Cloudflare 的技術紀錄依帳戶設定與平台政策保存。</p>
      <p>若要停止或刪除資料，可撤銷或輪替 API Key、移除相關 Notion／GitHub 整合、在 Notion 或 GitHub 刪除相應內容，並由 Cloudflare 帳戶管理者清除相關 KV 或可控制的紀錄。刪除第三方服務資料時，也適用該服務的保留與備份規則。</p>

      <h2>七、安全</h2>
      <p>Gateway 使用 HTTPS、API Key 驗證、回應大小限制與安全範圍的公開 OpenAPI Schema。任何網路服務都無法保證絕對安全；若懷疑憑證外洩，應立即輪替 API Key 並檢查 Notion、GitHub 與 Cloudflare 的存取紀錄。</p>

      <h2>八、聯絡方式</h2>
      <p>隱私或資料處理問題，請至 <a href="https://github.com/amber0983310929-coder">Gateway 建立者的公開 GitHub 個人頁</a> 查看其公開聯絡方式。若該頁未提供可用聯絡方式，請停止使用本 Gateway，並依上節立即撤銷 API Key 與相關整合，以阻止後續資料處理。</p>
    </main>
  </body>
</html>`;
