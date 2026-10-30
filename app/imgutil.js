/* ============================================================
   Solin — imgutil.js
   Client-side image processing & nutrition OCR module.
   - Image downscaling and compression before upload (prevents HTTP 413).
   - Multi-language nutrition label text parser (Hungarian / English / German).
   - In-browser OCR extraction using Tesseract.js with tabular support.
   ============================================================ */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SolinImg = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /**
   * Normalize and parse a single macro number string extracted from OCR.
   * Handles OCR quirks like:
   *  - Delimiters: "," / "." / "'" / "·" / "•" / ":" / "-" / space between digits (e.g. "45,6", "45 6", "45'6")
   *  - Missing decimal commas/dots in tight font (e.g. "456" -> 45.6g, "186" -> 18.6g)
   *  - "g" misread as trailing "9" (e.g. "45,09", "1809", "099", "029", "09", "4009")
   *  - Accidental non-numeric noise
   *  - Salt (g) -> Sodium (mg) conversion (1g salt ≈ 400mg sodium)
   */
  function cleanMacroNumber(str, key) {
    if (!str) return null;
    let s = String(str).trim().toLowerCase();

    if (key === "calories") {
      const kcalMatch = s.match(/(\d+(?:[.,\s]\d+)?)\s*kcal/i);
      if (kcalMatch) return Math.round(parseFloat(kcalMatch[1].replace(/,/g, ".").replace(/\s+/g, "")));
      const kjMatch = s.match(/(\d+(?:[.,\s]\d+)?)\s*k[j3]/i);
      if (kjMatch) return Math.round(parseFloat(kjMatch[1].replace(/,/g, ".").replace(/\s+/g, "")) / 4.184);
      const anyNum = s.match(/(\d+)/);
      return anyNum ? parseInt(anyNum[1], 10) : null;
    }

    // 1. Normalize delimiters: comma, dot, apostrophe, middle dot, colon, dash between digits
    s = s.replace(/(\d)\s*[,.\x27·•~:;-]\s*(\d)/g, "$1.$2");
    // Normalize digit space single-digit (e.g. "45 6 g" -> "45.6 g")
    s = s.replace(/(\d)\s+(\d)(?=\s*(?:g|mg|kcal|9)|$)/g, "$1.$2");

    // Strip leading / trailing OCR symbols
    s = s.replace(/^[|:;=\-—~_\])}]+/, "").replace(/[|:;=\-—~_{([]+$/, "").trim();

    const isMg = /mg\b/i.test(s);
    const isG = /g\b/i.test(s);
    let numPart = s.replace(/[^\d.]/g, "").trim();

    if (!numPart) return null;

    if (!isMg) {
      if (numPart.includes(".")) {
        // Case 1: Trailing 9 on decimal (e.g. "0.99" where original was "0.9 g" and "g" became 9)
        if (/^\d+\.\d9$/.test(numPart) && key !== "sodium") {
          numPart = numPart.slice(0, -1);
        }
      } else {
        // Case 2: Multi-digit integer without dot (e.g. "456", "4509", "1809", "099", "029", "09", "4009")
        if (numPart.startsWith("0") && numPart.length >= 2) {
          if (numPart.length === 3) {
            numPart = "0." + numPart[1]; // e.g. "099" -> 0.9, "029" -> 0.2
          } else if (numPart === "09" || numPart === "00") {
            numPart = "0"; // "0" + "g" -> 0g
          } else {
            numPart = "0." + numPart[1];
          }
        } else {
          if (numPart.endsWith("9") && numPart.length > 2 && !isG) {
            numPart = numPart.slice(0, -1); // strip trailing "9" representing unit "g"
          }

          if (key === "sodium" || key === "salt") {
            // Salt in grams: "400" -> 4.00g, "40" -> 0.40g
            if (numPart.length === 3) {
              numPart = (parseFloat(numPart) / 100).toFixed(2);
            } else if (numPart.length === 2) {
              numPart = (parseFloat(numPart) / 10).toFixed(1);
            }
          } else {
            // For macros per 100g (fat, protein, carbs, fiber, sugar): max possible is 100g!
            // Any value >= 100g on a 100g label had its decimal dropped (e.g. "456" -> 45.6, "186" -> 18.6, "450" -> 45.0)
            if (numPart.length === 3 && parseFloat(numPart) >= 100) {
              numPart = (parseFloat(numPart) / 10).toFixed(1);
            }
          }
        }
      }
    }

    const val = parseFloat(numPart);
    if (isNaN(val)) return null;

    if (key === "sodium" || key === "salt") {
      if (isMg) return Math.round(val);
      // Convert salt in grams to sodium in mg (1g salt ≈ 400mg sodium)
      return Math.round(val * 400);
    }

    return Math.round(val * 100) / 100;
  }

  // Lookahead boundary safe for Hungarian accents (JS \b only matches ASCII)
  const W = "(?![a-záéíóöőúüű])";

  const labelPatterns = {
    calories: [
      new RegExp("(?:energia|energy|energie|kal[oó]ria|calories?|brennwert)" + W, "i"),
      new RegExp("(\\d+(?:\\.\\d+)?)\\s*kcal" + W, "i")
    ],
    fat: [
      new RegExp("(?:^|[^a-záéíóöőúüű])(?:zs[ií1l][rt]|isit|lsir|total\\s*fat|fat|fett)" + W, "i")
    ],
    carbs: [
      new RegExp("(?:sz[eé]nhidr[aá]t|carbohydrate|total\\s*carb(?:ohydrate)?|carbs|kohlenhydrate)" + W, "i")
    ],
    sugar: [
      new RegExp("(?:amelyb[oöőeé06d][l1]?\\s*(?:cukr|cukt|cukor|cukrok)|cukrok?|cukor|of\\s*which\\s*sugars?|total\\s*sugars?|sugars?|davon\\s*zucker|zucker)" + W, "i")
    ],
    fiber: [
      new RegExp("(?:[eé]lelmi\\s*rost|rost|dietary\\s*fiber|fiber|fibre|ballaststoffe)" + W, "i")
    ],
    protein: [
      new RegExp("(?:feh[eé]rje|feh[eé]r]e|feherje|protein|eiwei[sß])" + W, "i")
    ],
    sodium: [
      new RegExp("(?:n[aá]trium|sodium)" + W, "i"),
      new RegExp("(?:^|[^a-záéíóöőúüű])(?:s[oó0$]|salt|salz)" + W, "i")
    ]
  };

  // Matches numeric tokens with flexible delimiters (e.g. "45,6", "45.6", "45, 6", "45 6", "45'6")
  const NUM_VALUE_RX = /[:=]?\s*([~<>]?\s*\d+(?:\s*[,.\x27·•~:;-]\s*\d+|\s+\d(?=\s*(?:g|mg|kcal|9)|$))?\s*(?:g|mg|kcal|9)?)/i;

  function isSaturatedLine(line) {
    return /tel[ií]tett|saturated|ges[aä]ttigt/i.test(line);
  }

  /**
   * Parse raw text from a nutrition facts table into canonical Solin macros:
   * calories, protein, carbs, fat, fiber, sugar, sodium.
   *
   * @param {string} rawText
   * @returns {Object} { calories, protein, carbs, fat, fiber, sugar, sodium, rawText }
   */
  function parseNutrition(rawText) {
    if (!rawText || typeof rawText !== "string") {
      return { rawText: "" };
    }

    const lines = rawText
      .split(/[\r\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    const result = {};

    // Pass 1: Match within a single line (key and value on same row)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Calories priority check (handles "1986 kJ/481 kcal" or "481 kcal")
      if (result.calories == null) {
        const kcalM = line.match(/(?:energia|energy|kal[oó]ria|calories?)?[^\d]*?(\d+(?:[.,\s]\d+)?)\s*k[j3]\s*[/|]\s*(\d+(?:[.,\s]\d+)?)\s*kcal/i)
          || line.match(/(\d+(?:[.,\s]\d+)?)\s*kcal/i)
          || line.match(/(?:calories|kal[oó]ria)\s*[:=]?\s*(\d+)/i);
        if (kcalM) {
          result.calories = cleanMacroNumber(kcalM[2] || kcalM[1], "calories");
        }
      }

      for (const [key, patterns] of Object.entries(labelPatterns)) {
        if (result[key] != null) continue;
        if (key === "fat" && isSaturatedLine(line)) continue;

        for (const rx of patterns) {
          const match = line.match(rx);
          if (match) {
            const after = line.slice(match.index + match[0].length);
            const numM = after.match(NUM_VALUE_RX);
            if (numM && /\d/.test(numM[1])) {
              const val = cleanMacroNumber(numM[1], key);
              if (val != null) {
                result[key] = val;
                break;
              }
            }
          }
        }
      }
    }

    // Pass 2: Check subsequent lines (table formats where value is on line i+1 or i+2)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // If line is calories header and next line has kJ/kcal
      if (result.calories == null && /energia|energy|energie|kal[oó]ria|calories?/i.test(line)) {
        for (let off = 1; off <= 2 && i + off < lines.length; off++) {
          const nxt = lines[i + off];
          const kcalM = nxt.match(/(\d+(?:[.,\s]\d+)?)\s*kcal/i)
            || nxt.match(/(\d+(?:[.,\s]\d+)?)\s*k[j3]/i);
          if (kcalM) {
            result.calories = cleanMacroNumber(kcalM[1], "calories");
            break;
          }
        }
      }

      for (const [key, patterns] of Object.entries(labelPatterns)) {
        if (result[key] != null) continue;
        if (key === "fat" && isSaturatedLine(line)) continue;

        for (const rx of patterns) {
          if (rx.test(line)) {
            for (let offset = 1; offset <= 2 && i + offset < lines.length; offset++) {
              const nextL = lines[i + offset];
              if (key === "fat" && isSaturatedLine(nextL)) break;

              // If nextL is another macro label, do not consume it as value
              const isOtherLabel = Object.keys(labelPatterns).some((k) =>
                k !== key && labelPatterns[k].some((p) => p.test(nextL))
              );
              if (isOtherLabel && !/^\d/.test(nextL)) break;

              const numM = nextL.match(/^[^a-záéíóöőúüű\d]*([~<>]?\s*\d+(?:\s*[,.\x27·•~:;-]\s*\d+|\s+\d(?=\s*(?:g|mg|kcal|9)|$))?\s*(?:g|mg|kcal|9)?)/i)
                || nextL.match(/([~<>]?\s*\d+(?:\s*[,.\x27·•~:;-]\s*\d+|\s+\d(?=\s*(?:g|mg|kcal|9)|$))?\s*(?:g|mg|kcal|9)?)$/i);

              if (numM && /\d/.test(numM[1])) {
                const val = cleanMacroNumber(numM[1], key);
                if (val != null) {
                  result[key] = val;
                  break;
                }
              }
            }
            if (result[key] != null) break;
          }
        }
      }
    }

    // Pass 3: Fallback for "Só" (Salt)
    // In low-resolution OCR, "Só" is very short and often read as "6", "$6", "SA8", or "S6"
    if (result.sodium == null) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^(?:6|\$6|sa8|s6|so)\b/i.test(line)) {
          const m = line.match(/(?:6|\$6|sa8|s6|so)[^\d]*?(\d+(?:[.,]\d+)?\s*(?:g|9)?)/i);
          if (m && /\d/.test(m[1])) {
            result.sodium = cleanMacroNumber(m[1], "sodium");
            break;
          } else if (i + 1 < lines.length) {
            const nextL = lines[i + 1];
            const nextM = nextL.match(/^(\d+(?:[.,]\d+)?\s*(?:g|9)?)/i);
            if (nextM && /\d/.test(nextM[1])) {
              result.sodium = cleanMacroNumber(nextM[1], "sodium");
              break;
            }
          }
        }
      }
    }

    result.rawText = rawText;
    return result;
  }

  /**
   * Preprocess image for OCR using canvas:
   *  - Grayscale conversion
   *  - Contrast enhancement (removes colored table-stripes and background tint)
   */
  function preprocessForOcr(source) {
    if (typeof document === "undefined" || !document.createElement) {
      return Promise.resolve(source); // Node test environment
    }

    return new Promise(function (resolve) {
      function processElement(img) {
        try {
          let w = img.naturalWidth || img.width;
          let h = img.naturalHeight || img.height;
          const maxDim = 2000;
          if (w > maxDim || h > maxDim) {
            if (w > h) {
              h = Math.round((h * maxDim) / w);
              w = maxDim;
            } else {
              w = Math.round((w * maxDim) / h);
              h = maxDim;
            }
          }
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#FFFFFF";
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);

          const imgData = ctx.getImageData(0, 0, w, h);
          const d = imgData.data;
          const contrast = 40;
          const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
          for (let i = 0; i < d.length; i += 4) {
            const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            const boosted = Math.min(255, Math.max(0, factor * (gray - 128) + 128));
            d[i] = boosted;
            d[i + 1] = boosted;
            d[i + 2] = boosted;
          }
          ctx.putImageData(imgData, 0, 0);
          resolve(canvas);
        } catch (err) {
          resolve(source);
        }
      }

      if (typeof HTMLCanvasElement !== "undefined" && source instanceof HTMLCanvasElement) {
        return resolve(source);
      }

      if (typeof HTMLImageElement !== "undefined" && source instanceof HTMLImageElement && source.complete && source.naturalWidth) {
        return processElement(source);
      }

      if (typeof Blob !== "undefined" && (source instanceof Blob || source instanceof File)) {
        const reader = new FileReader();
        reader.onload = function (e) {
          const img = new Image();
          img.onload = () => processElement(img);
          img.onerror = () => resolve(source);
          img.src = e.target.result;
        };
        reader.onerror = () => resolve(source);
        reader.readAsDataURL(source);
        return;
      }

      if (typeof source === "string") {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => processElement(img);
        img.onerror = () => resolve(source);
        img.src = source;
        return;
      }

      resolve(source);
    });
  }

  /**
   * Downscale and compress an image file client-side.
   * Typical 12MB iPhone photo -> ~300KB high-definition JPEG.
   */
  function compress(file, options) {
    options = options || {};
    const maxWidth = options.maxWidth || 1600;
    const maxHeight = options.maxHeight || 1600;
    const quality = options.quality || 0.82;
    const mimeType = options.mimeType || "image/jpeg";

    return new Promise(function (resolve, reject) {
      if (!file || typeof file !== "object") {
        return reject(new Error("Érvénytelen fájl objektum"));
      }

      // If running in environment without DOM/Canvas (e.g. Node tests), passthrough
      if (typeof window === "undefined" || typeof document === "undefined" || !document.createElement) {
        return resolve({
          file: file,
          blob: file,
          originalSize: file.size || 0,
          compressedSize: file.size || 0,
          width: 0,
          height: 0
        });
      }

      // Non-image files pass through directly
      if (file.type && !file.type.startsWith("image/")) {
        return resolve({
          file: file,
          blob: file,
          originalSize: file.size,
          compressedSize: file.size
        });
      }

      const reader = new FileReader();
      reader.onerror = function () {
        reject(new Error("Nem sikerült beolvasni a képet"));
      };

      reader.onload = function (e) {
        const img = new Image();
        img.onerror = function () {
          reject(new Error("Nem sikerült dekódolni a képet"));
        };

        img.onload = function () {
          let width = img.naturalWidth || img.width;
          let height = img.naturalHeight || img.height;

          // Downscale keeping aspect ratio
          if (width > maxWidth || height > maxHeight) {
            if (width / height > maxWidth / maxHeight) {
              height = Math.round((height * maxWidth) / width);
              width = maxWidth;
            } else {
              width = Math.round((width * maxHeight) / height);
              height = maxHeight;
            }
          }

          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");

          // Clean background for PNGs with transparency converted to JPEG
          if (mimeType === "image/jpeg") {
            ctx.fillStyle = "#FFFFFF";
            ctx.fillRect(0, 0, width, height);
          }

          ctx.drawImage(img, 0, 0, width, height);

          canvas.toBlob(
            function (blob) {
              if (!blob) {
                return resolve({
                  file: file,
                  blob: file,
                  dataUrl: e.target.result,
                  originalSize: file.size,
                  compressedSize: file.size,
                  width: width,
                  height: height
                });
              }

              const ext = mimeType === "image/webp" ? ".webp" : ".jpg";
              const rawName = file.name || "image";
              const cleanName = rawName.replace(/\.[^/.]+$/, "") + ext;

              let compressedFile;
              try {
                compressedFile = new File([blob], cleanName, {
                  type: mimeType,
                  lastModified: Date.now()
                });
              } catch (err) {
                compressedFile = blob;
              }

              resolve({
                file: compressedFile,
                blob: blob,
                canvas: canvas,
                dataUrl: canvas.toDataURL(mimeType, quality),
                originalSize: file.size,
                compressedSize: blob.size,
                width: width,
                height: height,
                ratio: Math.round(((file.size - blob.size) / (file.size || 1)) * 100)
              });
            },
            mimeType,
            quality
          );
        };

        img.src = e.target.result;
      };

      reader.readAsDataURL(file);
    });
  }

  /**
   * Run OCR on an image source (Blob / Canvas / DataURL) using Tesseract.js.
   * Uses PSM 11 (Sparse text) to prevent tabular column dropouts.
   */
  async function extractNutrition(imageSource, onProgress) {
    if (typeof Tesseract === "undefined") {
      throw new Error("A Tesseract OCR motor nem elérhető.");
    }

    if (typeof onProgress === "function") {
      onProgress({ status: "loading", progress: 0.1, message: "Kép előkészítése OCR elemzéshez..." });
    }

    // Preprocess image (grayscale + contrast boost)
    const processedSource = await preprocessForOcr(imageSource);

    if (typeof onProgress === "function") {
      onProgress({ status: "loading", progress: 0.25, message: "OCR motor betöltése (hun+eng)..." });
    }

    const workerLogger = function (m) {
      if (typeof onProgress === "function" && m) {
        onProgress({
          status: m.status || "processing",
          progress: m.progress != null ? 0.3 + m.progress * 0.7 : 0.5,
          message: m.status === "recognizing text"
            ? `Szöveg felismerése: ${Math.round((m.progress || 0) * 100)}%`
            : (m.status || "Feldolgozás...")
        });
      }
    };

    let worker;
    try {
      worker = await Tesseract.createWorker("hun+eng", 1, { logger: workerLogger });
    } catch (e) {
      // Fallback: try English only
      worker = await Tesseract.createWorker("eng", 1, { logger: workerLogger });
    }

    try {
      // PSM 11: Find sparse text - crucial for nutrition tables where right column would be dropped
      try {
        await worker.setParameters({
          tessedit_pageseg_mode: "11"
        });
      } catch (paramErr) {
        console.warn("[OCR] Could not set PSM 11, continuing with default:", paramErr);
      }

      let ret = await worker.recognize(processedSource);
      let text = ret && ret.data && ret.data.text ? ret.data.text : "";
      let macros = parseNutrition(text);

      // If fewer than 3 macros detected, try fallback with PSM 6 (single uniform block)
      const count = Object.keys(macros).filter((k) => k !== "rawText" && macros[k] != null).length;
      if (count < 3) {
        try {
          await worker.setParameters({ tessedit_pageseg_mode: "6" });
          const ret2 = await worker.recognize(processedSource);
          const text2 = ret2 && ret2.data && ret2.data.text ? ret2.data.text : "";
          const combined = parseNutrition(text + "\n" + text2);
          const count2 = Object.keys(combined).filter((k) => k !== "rawText" && combined[k] != null).length;
          if (count2 > count) {
            text = text + "\n---\n" + text2;
            macros = combined;
          }
        } catch (fallbackErr) {
          console.warn("[OCR] PSM 6 fallback failed:", fallbackErr);
        }
      }

      await worker.terminate();
      return { text: text, macros: macros };
    } catch (err) {
      if (worker) {
        try { await worker.terminate(); } catch (ignore) {}
      }
      throw new Error("Nem sikerült beolvasni a címkét: " + (err.message || String(err)));
    }
  }

  function formatBytes(bytes) {
    if (!bytes || isNaN(bytes)) return "0 B";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  return {
    parseNutrition: parseNutrition,
    compress: compress,
    extractNutrition: extractNutrition,
    formatBytes: formatBytes
  };
});

