/* ============================================================
   Solin — imgutil.js
   Client-side image processing & nutrition OCR module.
   - Image downscaling and compression before upload (prevents HTTP 413).
   - Multi-language nutrition label text parser (Hungarian / English / German).
   - In-browser OCR extraction using Tesseract.js.
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

    // Normalize commas to dots, keep original structure
    const norm = rawText.replace(/,/g, ".").toLowerCase();
    const lines = norm.split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
    const result = {};

    const patterns = {
      calories: [
        /(?:energia|energy|energie|kalória|calories|brennwert)[^\d]*?(\d+(?:\.\d+)?)\s*kcal/i,
        /(\d+(?:\.\d+)?)\s*kcal/i,
        /(?:energia|energy|energie).*?(\d+(?:\.\d+)?)\s*kj.*?(\d+(?:\.\d+)?)\s*kcal/i,
        /(?:calories|kalória)\s*[:=]?\s*(\d+(?:\.\d+)?)/i
      ],
      protein: [
        /(?:fehérje|protein|eiweiß|eiweiss)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*g?/i
      ],
      fat: [
        /(?:^|[^a-záéíóöőúüű])(?:zsír|fat|fett|total fat)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*g?/i
      ],
      carbs: [
        /(?:^|[^a-záéíóöőúüű])(?:szénhidrát|carbohydrate|carbs|kohlenhydrate|total carb(?:ohydrate)?)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*g?/i
      ],
      sugar: [
        /(?:amelyből cukrok?|amelybol cukrok?|of which sugars?|davon zucker|cukor|cukrok|sugars?)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*g?/i
      ],
      fiber: [
        /(?:élelmi rost|élelmirost|rost|fiber|dietary fiber|ballaststoffe)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*g?/i
      ],
      sodium: [
        /(?:nátrium|sodium)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(?:mg|g)?/i,
        /(?:só|salt|salz)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*g/i
      ]
    };

    // Pass 1: match within single lines
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const [key, regexList] of Object.entries(patterns)) {
        if (result[key] != null) continue;
        if (key === "fat" && (line.includes("telített") || line.includes("saturated") || line.includes("gesättigt"))) {
          continue;
        }

        for (const rx of regexList) {
          const m = line.match(rx);
          if (m) {
            let val = parseFloat(m[1] || m[m.length - 1]);
            if (!isNaN(val)) {
              const matchedStr = m[0];
              if (key === "sodium") {
                if (/só|salt|salz/i.test(matchedStr) || /só|salt|salz/i.test(line)) {
                  val = Math.round(val * 400); // 1g salt ≈ 400mg sodium
                } else if (/g\b/i.test(matchedStr) && !/mg/i.test(matchedStr) && val < 50) {
                  val = Math.round(val * 1000);
                }
              }
              result[key] = Math.round(val * 100) / 100;
              break;
            }
          }
        }
      }
    }

    // Pass 2: check adjacent multi-line pairs for table formats (e.g. key on line i, value on line i+1)
    for (let i = 0; i < lines.length - 1; i++) {
      const pair = lines[i] + " " + lines[i + 1];
      for (const [key, regexList] of Object.entries(patterns)) {
        if (result[key] != null) continue;
        if (key === "fat" && (pair.includes("telített") || pair.includes("saturated") || pair.includes("gesättigt"))) {
          continue;
        }

        for (const rx of regexList) {
          const m = pair.match(rx);
          if (m) {
            let val = parseFloat(m[1] || m[m.length - 1]);
            if (!isNaN(val)) {
              const matchedStr = m[0];
              if (key === "sodium") {
                if (/só|salt|salz/i.test(matchedStr) || /só|salt|salz/i.test(pair)) {
                  val = Math.round(val * 400);
                } else if (/g\b/i.test(matchedStr) && !/mg/i.test(matchedStr) && val < 50) {
                  val = Math.round(val * 1000);
                }
              }
              result[key] = Math.round(val * 100) / 100;
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
   */
  async function extractNutrition(imageSource, onProgress) {
    if (typeof Tesseract === "undefined") {
      throw new Error("A Tesseract OCR motor nem elérhető.");
    }

    if (typeof onProgress === "function") {
      onProgress({ status: "loading", progress: 0.1, message: "OCR motor inicializálása..." });
    }

    try {
      const worker = await Tesseract.createWorker("hun+eng", 1, {
        logger: function (m) {
          if (typeof onProgress === "function" && m) {
            onProgress({
              status: m.status || "processing",
              progress: m.progress != null ? m.progress : 0.5,
              message: m.status === "recognizing text"
                ? `Szöveg felismerése: ${Math.round((m.progress || 0) * 100)}%`
                : (m.status || "Feldolgozás...")
            });
          }
        }
      });

      const ret = await worker.recognize(imageSource);
      await worker.terminate();

      const text = ret && ret.data && ret.data.text ? ret.data.text : "";
      const macros = parseNutrition(text);
      return { text: text, macros: macros };
    } catch (e) {
      // Fallback: try English only if hun+eng fails
      try {
        const worker = await Tesseract.createWorker("eng", 1);
        const ret = await worker.recognize(imageSource);
        await worker.terminate();
        const text = ret && ret.data && ret.data.text ? ret.data.text : "";
        const macros = parseNutrition(text);
        return { text: text, macros: macros };
      } catch (err2) {
        throw new Error("Nem sikerült beolvasni a címkét: " + (e.message || String(e)));
      }
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
