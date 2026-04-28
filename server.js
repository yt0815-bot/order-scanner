require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const ExcelJS = require('exceljs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `あなたはアパレル業界の発注書を読み取るAIです。
画像から発注情報を抽出し、必ずJSONのみで返答してください。前置き・説明文は不要です。

## 読み取りルール

【ルール①】取り消し線・修正箇所の除外
- 横線（取り消し線）で消されている数字・文字は一切読み取らない。消されていない最新の値のみ採用する。
- 数量（発注数）に取り消し線がある行、または数量が空欄・未記載の行は colors に含めない。
- 数量が明確に記載されている行のみを対象とする。

【ルール②】画像タイプの判定と品番・品名の処理
- 国内発注書（Style No.欄・Item欄あり）：そのまま使用。temp_no は null。
- 海外出張写真（品番・品名なし）：temp_no はシステム側で付番するため必ず null を返す。画像の商品特徴から仮品名を生成すること。
  仮品名の例：「ジオメトリックプリントTシャツ」「ダブルブレストショートジャケット」「カーゴイージーパンツ」

【ルール③】納期の読み取り
- 画像内に明示されている納期のみ採用する
- 書かれていないカラー行の納期は必ずnullとする（推測・補完しない）
- 赤文字・青文字などの色付き文字も必ず読み取る
- 表記の変換：8上→8月上旬、8中→8月中旬、8末→8月末、9/上〜中→9月上旬〜中旬、10/6→10月6日

【ルール④】カラー表記の統一（すべてカタカナに変換）
BK/BLK→ブラック、WH/WHT→ホワイト、BR/BRW→ブラウン
IVO/IU/IV→アイボリー、GY/GRY→グレー、LtGY/LGY→ライトグレー
CHA/CHR→チャコール、NV/NVY→ネイビー、BE/BEG→ベージュ
SAX/SX→サックス、RD/RED→レッド、BL/BLU→ブルー
上記以外は画像表記から最も近いカタカナ色名に変換すること

【ルール⑤】文脈からの色推測
隣に映っている別色の商品、手書き文字の位置・順番から各行のカラーを文脈で判断すること

## 返答フォーマット
{
  "style_no": "品番またはnull",
  "item_name": "品名または仮品名",
  "temp_no": null,
  "retail_price": 数値または null,
  "wholesale_price": 数値または null,
  "colors": [
    {
      "color_code": "カラーコード略称",
      "color_name": "カタカナカラー名",
      "deadline": "納期文字列または null（画像に記載がない場合は必ずnull）",
      "quantity": 数値（必ず1以上の整数。未記載・取り消し線がある行はこの配列に含めない）,
      "note": "備考（丸囲み文字・特記事項）または空文字"
    }
  ],
  "total_quantity": 数値または null,
  "country": "生産国または null",
  "image_note": "読み取り時の注意・不明点（なければ空文字）"
}`;

// 画像1枚をAnthropic APIに送信してJSONをパース
async function analyzeImage(imageData, mimeType) {
  const response = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mimeType,
              data: imageData,
            },
          },
          {
            type: 'text',
            text: 'この発注書画像から発注情報を読み取り、指定のJSONフォーマットで返してください。数量が未記載・取り消し線がある行はcolorsに含めないでください。',
          },
        ],
      },
    ],
  });

  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/```\s*([\s\S]*?)\s*```/);
  const jsonText = jsonMatch ? jsonMatch[1] : text;
  return JSON.parse(jsonText);
}

// 後処理: 仮品番付番 + 数量なし行の除外
function postProcess(parsed, imageIndex) {
  // 仮品番: style_no がない画像には画像番号ベースで1つ付番
  if (!parsed.style_no) {
    parsed.temp_no = String(imageIndex + 1).padStart(3, '0');
  } else {
    parsed.temp_no = null;
  }

  // 数量が null / 0 / 未定義のカラー行を除外
  if (Array.isArray(parsed.colors)) {
    parsed.colors = parsed.colors.filter(c => {
      const qty = Number(c.quantity);
      return !isNaN(qty) && qty > 0;
    });
  }

  return parsed;
}

// POST /api/analyze
app.post('/api/analyze', async (req, res) => {
  try {
    const { images, imageIndexOffset = 0 } = req.body;
    if (!images || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: '画像データが必要です' });
    }

    const results = [];
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      try {
        const parsed = await analyzeImage(img.data, img.mimeType || 'image/jpeg');
        const processed = postProcess(parsed, imageIndexOffset + i);
        results.push({ success: true, data: processed });
      } catch (err) {
        results.push({ success: false, error: err.message });
      }
    }

    res.json({ results });
  } catch (err) {
    console.error('analyze error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/export
app.post('/api/export', async (req, res) => {
  try {
    const { rows, filename } = req.body;
    if (!rows || !Array.isArray(rows)) {
      return res.status(400).json({ error: '明細データが必要です' });
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'order-scanner';
    workbook.created = new Date();

    const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
    const headerFont = { bold: true };
    const borderStyle = { style: 'thin', color: { argb: 'FF999999' } };
    const allBorders = { top: borderStyle, left: borderStyle, bottom: borderStyle, right: borderStyle };

    const currencyFmt = '¥#,##0';
    const percentFmt = '0.0%';

    function autoWidth(sheet) {
      sheet.columns.forEach(col => {
        let max = col.header ? String(col.header).length : 8;
        col.eachCell({ includeEmpty: true }, cell => {
          const len = cell.value ? String(cell.value).length : 0;
          if (len > max) max = len;
        });
        col.width = Math.min(max + 2, 40);
      });
    }

    // ---- シート1: 明細 ----
    const sheet1 = workbook.addWorksheet('明細');
    sheet1.columns = [
      { header: '品番', key: 'style_no', width: 15 },
      { header: '仮品番', key: 'temp_no', width: 10 },
      { header: '品名', key: 'item_name', width: 25 },
      { header: 'カラーコード', key: 'color_code', width: 14 },
      { header: 'カラー名', key: 'color_name', width: 14 },
      { header: '納期', key: 'deadline', width: 14 },
      { header: '上代', key: 'retail_price', width: 12 },
      { header: '掛け率', key: 'rate', width: 10 },
      { header: '下代', key: 'wholesale_price', width: 12 },
      { header: '枚数', key: 'quantity', width: 8 },
      { header: '小計(下代)', key: 'subtotal_w', width: 14 },
      { header: '小計(上代)', key: 'subtotal_r', width: 14 },
      { header: '備考', key: 'note', width: 20 },
      { header: '生産国', key: 'country', width: 10 },
    ];

    // ヘッダー行スタイル
    sheet1.getRow(1).eachCell(cell => {
      cell.fill = headerFill;
      cell.font = headerFont;
      cell.border = allBorders;
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });

    let dataRowStart = 2;
    rows.forEach((row, idx) => {
      const rowNum = dataRowStart + idx;
      const rate = (row.retail_price && row.wholesale_price)
        ? row.wholesale_price / row.retail_price
        : null;

      const dataRow = sheet1.addRow({
        style_no: row.style_no || '',
        temp_no: row.temp_no || '',
        item_name: row.item_name || '',
        color_code: row.color_code || '',
        color_name: row.color_name || '',
        deadline: row.deadline || '',
        retail_price: row.retail_price || null,
        rate: rate,
        wholesale_price: row.wholesale_price || null,
        quantity: row.quantity || null,
        subtotal_w: null,
        subtotal_r: null,
        note: row.note || '',
        country: row.country || '',
      });

      // 計算式: 小計(下代)=下代×枚数, 小計(上代)=上代×枚数
      dataRow.getCell('subtotal_w').value = { formula: `I${rowNum}*J${rowNum}` };
      dataRow.getCell('subtotal_r').value = { formula: `G${rowNum}*J${rowNum}` };

      dataRow.getCell('retail_price').numFmt = currencyFmt;
      dataRow.getCell('wholesale_price').numFmt = currencyFmt;
      dataRow.getCell('subtotal_w').numFmt = currencyFmt;
      dataRow.getCell('subtotal_r').numFmt = currencyFmt;
      dataRow.getCell('rate').numFmt = percentFmt;

      dataRow.eachCell({ includeEmpty: true }, cell => {
        cell.border = allBorders;
      });
    });

    // 合計行
    const totalRow = sheet1.rowCount + 1;
    const sumRow = sheet1.addRow({
      style_no: '合計',
      quantity: null,
      subtotal_w: null,
      subtotal_r: null,
    });
    sumRow.getCell('quantity').value = { formula: `SUM(J${dataRowStart}:J${totalRow - 1})` };
    sumRow.getCell('subtotal_w').value = { formula: `SUM(K${dataRowStart}:K${totalRow - 1})` };
    sumRow.getCell('subtotal_r').value = { formula: `SUM(L${dataRowStart}:L${totalRow - 1})` };
    sumRow.getCell('subtotal_w').numFmt = currencyFmt;
    sumRow.getCell('subtotal_r').numFmt = currencyFmt;
    sumRow.font = { bold: true };
    sumRow.fill = headerFill;
    sumRow.eachCell({ includeEmpty: true }, cell => { cell.border = allBorders; });

    autoWidth(sheet1);

    // ---- シート2: スタイル別集計 ----
    const sheet2 = workbook.addWorksheet('スタイル別集計');
    sheet2.columns = [
      { header: '品番', key: 'style_no', width: 15 },
      { header: '仮品番', key: 'temp_no', width: 10 },
      { header: '品名', key: 'item_name', width: 25 },
      { header: '上代', key: 'retail_price', width: 12 },
      { header: '下代', key: 'wholesale_price', width: 12 },
      { header: '合計枚数', key: 'total_qty', width: 10 },
      { header: '合計小計(下代)', key: 'total_subtotal_w', width: 16 },
      { header: '合計小計(上代)', key: 'total_subtotal_r', width: 16 },
      { header: '生産国', key: 'country', width: 10 },
    ];
    sheet2.getRow(1).eachCell(cell => {
      cell.fill = headerFill;
      cell.font = headerFont;
      cell.border = allBorders;
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });

    // スタイル別に集計
    const styleMap = new Map();
    rows.forEach(row => {
      const key = row.style_no || row.temp_no || row.item_name;
      if (!styleMap.has(key)) {
        styleMap.set(key, {
          style_no: row.style_no || '',
          temp_no: row.temp_no || '',
          item_name: row.item_name || '',
          retail_price: row.retail_price || null,
          wholesale_price: row.wholesale_price || null,
          total_qty: 0,
          total_subtotal_w: 0,
          total_subtotal_r: 0,
          country: row.country || '',
        });
      }
      const s = styleMap.get(key);
      const qty = Number(row.quantity) || 0;
      s.total_qty += qty;
      s.total_subtotal_w += qty * (Number(row.wholesale_price) || 0);
      s.total_subtotal_r += qty * (Number(row.retail_price) || 0);
    });

    styleMap.forEach(s => {
      const r = sheet2.addRow(s);
      r.getCell('retail_price').numFmt = currencyFmt;
      r.getCell('wholesale_price').numFmt = currencyFmt;
      r.getCell('total_subtotal_w').numFmt = currencyFmt;
      r.getCell('total_subtotal_r').numFmt = currencyFmt;
      r.eachCell({ includeEmpty: true }, cell => { cell.border = allBorders; });
    });

    const s2Total = sheet2.rowCount + 1;
    const s2Sum = sheet2.addRow({ style_no: '合計' });
    s2Sum.getCell('total_qty').value = { formula: `SUM(F2:F${s2Total - 1})` };
    s2Sum.getCell('total_subtotal_w').value = { formula: `SUM(G2:G${s2Total - 1})` };
    s2Sum.getCell('total_subtotal_r').value = { formula: `SUM(H2:H${s2Total - 1})` };
    s2Sum.getCell('total_subtotal_w').numFmt = currencyFmt;
    s2Sum.getCell('total_subtotal_r').numFmt = currencyFmt;
    s2Sum.font = { bold: true };
    s2Sum.fill = headerFill;
    s2Sum.eachCell({ includeEmpty: true }, cell => { cell.border = allBorders; });
    autoWidth(sheet2);

    // ---- シート3: カラー変換一覧 ----
    const sheet3 = workbook.addWorksheet('カラー変換一覧');
    sheet3.columns = [
      { header: '品番', key: 'style_no', width: 15 },
      { header: '品名', key: 'item_name', width: 25 },
      { header: 'カラーコード(元)', key: 'color_code', width: 16 },
      { header: 'カラー名(カタカナ)', key: 'color_name', width: 18 },
    ];
    sheet3.getRow(1).eachCell(cell => {
      cell.fill = headerFill;
      cell.font = headerFont;
      cell.border = allBorders;
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });

    rows.forEach(row => {
      if (row.color_code || row.color_name) {
        const r = sheet3.addRow({
          style_no: row.style_no || row.temp_no || '',
          item_name: row.item_name || '',
          color_code: row.color_code || '',
          color_name: row.color_name || '',
        });
        r.eachCell({ includeEmpty: true }, cell => { cell.border = allBorders; });
      }
    });
    autoWidth(sheet3);

    // レスポンスとして返す
    const safeFilename = encodeURIComponent(filename || '発注集計');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${safeFilename}.xlsx`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('export error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`発注書スキャナー起動中: http://localhost:${PORT}`);
});
