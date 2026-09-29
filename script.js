"use strict";

// ===== 설정값 (PRD 3.1) =====
const MAX_FILES = 50;
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

// ===== 에러 메시지 (PRD 3.4) =====
const MESSAGES = {
  invalidType: "이미지 파일(JPG, JPEG)만 업로드할 수 있습니다.",
  corrupted: "일부 이미지를 읽을 수 없습니다. 손상되었을 수 있습니다.",
  limitExceeded: "파일 크기/개수 제한을 초과했습니다.",
  noFiles: "최소 1장 이상의 영수증 사진을 업로드해주세요.",
  generateFailed: "PDF 생성 중 오류가 발생했습니다. 다시 시도해주세요.",
  libraryMissing:
    "PDF 라이브러리(jsPDF)를 불러오지 못했습니다. 인터넷 연결을 확인한 뒤 새로고침해주세요.",
};

// ===== 필수 입력 항목 (PDF 생성 전 검증) =====
const REQUIRED_FIELDS = [
  { id: "meta-account", message: "계정과목이 입력되지 않았습니다." },
  { id: "meta-user", message: "사용자가 입력되지 않았습니다." },
  { id: "meta-total", message: "총금액(원)이 입력되지 않았습니다." },
];

// ===== PDF 레이아웃 (단위 mm, 페이지는 사진 방향과 무관하게 항상 A4 가로) =====
// 페이지 구성: 상단 가운데 제목 → 그 아래 직사각형 테두리(사진 영역) → 테두리 하단에 붙은 정보 표
const LAYOUT = {
  pageWidth: 297,
  pageHeight: 210,
  marginX: 12, // 좌우 여백 (테두리 바깥)
  marginBottom: 12, // 하단 여백 (테두리 바깥, 페이지 번호가 들어감)
  titleTop: 8, // 제목 영역 시작
  titleHeight: 12, // 제목 영역 높이
  titleGap: 3, // 제목과 테두리 사이
  padding: 6, // 테두리 안쪽 여백 (테두리/표 ↔ 사진)
  gap: 5, // 사진 사이 간격
  tableHeight: 8, // 정보 표 높이 (1줄: 칸마다 "라벨 | 값")
};
const TITLE_TEXT = "증 빙 서";
// 고정 그리드의 열×행을 고를 때 기준으로 삼는 사진 비율(가로/세로) — 세로로 찍은 영수증(3:4)
const GRID_REFERENCE_ASPECT = 3 / 4;
const IMAGE_DPI = 200; // PDF에 넣을 사진 해상도 기준 (이보다 크면 축소, 작으면 그대로)
const JPEG_QUALITY = 0.85;
const TEXT_PX_PER_MM = 8; // 한글 글자 이미지 해상도
const KOREAN_FONT =
  '"Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';

// 정보 표 1줄 구성. 칸마다 [라벨(고정 폭) | 값(weight 비율로 나머지 폭 분배)]
// — 값이 길어질 수 있는 계정과목/총금액 칸을 넓게 준다.
const FOOTER_COLUMNS = [
  { key: "account", label: "계정과목", weight: 1.3 },
  { key: "user", label: "사용자", weight: 1 },
  { key: "type", label: "증빙구분", weight: 0.9 },
  { key: "month", label: "증빙월", weight: 0.7 },
  { key: "total", label: "총금액(원)", weight: 1.4 },
];
const FOOTER_TEXT = {
  labelWidth: 18, // 라벨 칸 폭(mm) — 가장 긴 "총금액(원)"이 3mm 글씨로 들어가는 폭
  labelSize: 3, // 라벨 글씨(mm)
  valueSize: 3.5, // 값 글씨(mm) — 칸보다 길면 minSize까지 줄인다
  minSize: 2.4,
  padding: 1.5, // 칸 좌우 안쪽 여백(mm)
};

// ===== DOM 참조 =====
const $ = (id) => document.getElementById(id);
const els = {
  dropzone: $("dropzone"),
  fileInput: $("file-input"),
  fileCount: $("file-count"),
  metaForm: $("meta-form"),
  perPage: $("opt-per-page"),
  status: $("status"),
  statusText: $("status-text"),
  error: $("error"),
  errorText: $("error-text"),
  errorDismiss: $("error-dismiss"),
  generateBtn: $("generate-btn"),
  resultSection: $("result-section"),
  pdfPreview: $("pdf-preview"),
  downloadBtn: $("download-btn"),
  resetBtn: $("reset-btn"),
};

// ===== 상태 =====
// idle → files_selected → arranging → generating → done
//                                          └→ error → (재시도 가능)
const state = {
  phase: "idle",
  files: [], // { id, file, name, info } — 업로드 순서 = PDF 배치 순서
  nextId: 1,
  loading: false, // 업로드한 파일 검사 중
  pdfUrl: null,
};
let loadQueue = Promise.resolve(); // 연속 업로드 시 순서대로 처리

// ===================================================================
// JPEG 헤더 파싱 — 디코딩 없이 시그니처/크기/EXIF 방향만 읽는다
// ===================================================================

// SOF(Start Of Frame) 마커 — 여기서 이미지 가로/세로를 읽는다. (C4 DHT, C8 JPG, CC DAC 제외)
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/** 파일 앞 3바이트가 JPEG 시그니처(FF D8 FF)인지 확인한다. */
function isJpeg(bytes) {
  return (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  );
}

/** APP1 "Exif\0\0" 세그먼트 안의 TIFF 구조에서 Orientation(0x0112) 값을 읽는다. 없으면 1. */
function readExifOrientation(bytes, start, end) {
  if (
    end - start < 14 ||
    bytes[start] !== 0x45 ||
    bytes[start + 1] !== 0x78 || // "Ex"
    bytes[start + 2] !== 0x69 ||
    bytes[start + 3] !== 0x66 || // "if"
    bytes[start + 4] !== 0 ||
    bytes[start + 5] !== 0
  ) {
    return 1;
  }
  const tiff = start + 6;
  let little;
  if (bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49)
    little = true; // "II"
  else if (bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d)
    little = false; // "MM"
  else return 1;

  const u16 = (p) =>
    little ? bytes[p] | (bytes[p + 1] << 8) : (bytes[p] << 8) | bytes[p + 1];
  const u32 = (p) =>
    little
      ? (bytes[p] |
          (bytes[p + 1] << 8) |
          (bytes[p + 2] << 16) |
          (bytes[p + 3] << 24)) >>>
        0
      : ((bytes[p] << 24) |
          (bytes[p + 1] << 16) |
          (bytes[p + 2] << 8) |
          bytes[p + 3]) >>>
        0;

  const ifd0 = tiff + u32(tiff + 4);
  if (ifd0 + 2 > end) return 1;
  const count = u16(ifd0);
  for (let i = 0; i < count; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > end) break;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

/**
 * JPEG 바이트에서 크기와 EXIF 방향을 읽는다.
 * displayWidth/Height는 EXIF 회전을 적용한 뒤(=사람이 보는 방향)의 크기.
 * @throws {Error} 헤더가 손상되었거나, 압축 데이터 끝(EOI)이 없어 파일이 잘린 경우
 */
function readJpegInfo(bytes) {
  if (!isJpeg(bytes)) throw new Error("JPEG 시그니처가 아닙니다.");

  let orientation = 1;
  let width = 0;
  let height = 0;
  let scanStart = -1;
  let p = 2;

  while (p + 4 <= bytes.length) {
    if (bytes[p] !== 0xff) throw new Error("JPEG 마커 구조가 손상되었습니다.");
    while (bytes[p] === 0xff && p < bytes.length) p++; // 채움 바이트(FF FF ...) 건너뛰기
    const marker = bytes[p++];

    if (marker === 0xd9) break; // EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // 길이 없는 마커

    const length = (bytes[p] << 8) | bytes[p + 1];
    const segStart = p + 2;
    const segEnd = p + length;
    if (length < 2 || segEnd > bytes.length)
      throw new Error("JPEG 세그먼트가 잘려 있습니다.");

    if (marker === 0xda) {
      scanStart = segEnd; // SOS — 이후는 압축 데이터
      break;
    }
    if (marker === 0xe1 && orientation === 1) {
      orientation = readExifOrientation(bytes, segStart, segEnd);
    } else if (SOF_MARKERS.has(marker)) {
      height = (bytes[segStart + 1] << 8) | bytes[segStart + 2];
      width = (bytes[segStart + 3] << 8) | bytes[segStart + 4];
    }
    p = segEnd;
  }

  if (!width || !height || scanStart < 0)
    throw new Error("JPEG 크기 정보를 찾을 수 없습니다.");

  // 브라우저는 잘린 JPEG도 회색으로 채워 "성공"으로 그리므로 끝 마커(FF D9)로 직접 확인한다.
  // 압축 데이터 안에는 FF D9가 나올 수 없고, 뒤에 붙은 부가 데이터가 있어도 EOI는 그 앞에 있다.
  let hasEnd = false;
  for (let i = bytes.length - 2; i >= scanStart; i--) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) {
      hasEnd = true;
      break;
    }
  }
  if (!hasEnd) throw new Error("JPEG 파일이 중간에 잘려 있습니다.");

  // Orientation 5~8은 90도 회전이 포함되어 가로/세로가 뒤바뀐다.
  const swapped = orientation >= 5;
  return {
    width,
    height,
    orientation,
    displayWidth: swapped ? height : width,
    displayHeight: swapped ? width : height,
  };
}

// ===================================================================
// 페이지 배치 계산 — 사진 비율만 보고 A4 가로 페이지 위의 위치/크기(mm)를 정한다
// ===================================================================

/**
 * n장을 페이지당 최대 perPage장으로 나누되, 장수를 최대한 고르게 분배한다.
 * 예) 7장, 3장씩 → [3, 2, 2]  (마지막 페이지에 1장만 남는 공간 낭비 방지)
 */
function splitIntoPages(n, perPage) {
  if (n === 0) return [];
  const pageCount = Math.ceil(n / perPage);
  const base = Math.floor(n / pageCount);
  const extra = n % pageCount;
  const counts = [];
  for (let i = 0; i < pageCount; i++) counts.push(base + (i < extra ? 1 : 0));
  return counts;
}

/**
 * perPage장을 담을 고정 그리드(열×행)를 고른다. 슬롯 크기는 문서 전체에서 하나로 고정된다.
 * 후보: 열 1~perPage, 행 = ceil(perPage/열). 빈 행이 통째로 생기는 조합은 제외.
 * 그중 기준 비율(GRID_REFERENCE_ASPECT, 세로 3:4 사진)을 contain으로 넣었을 때 가장 크게 들어가는 조합을 쓴다.
 * 현재 영역(261×149mm) 기준 결과: 3장 → 3×1, 4장 → 4×1, 5·6장 → 3×2
 */
function chooseGrid(perPage, area, gap) {
  let best = null;
  for (let cols = 1; cols <= perPage; cols++) {
    const rows = Math.ceil(perPage / cols);
    if (cols * rows - perPage >= cols) continue; // 빈 행 발생
    const cellWidth = (area.width - gap * (cols - 1)) / cols;
    const cellHeight = (area.height - gap * (rows - 1)) / rows;
    const fitted = containSize(GRID_REFERENCE_ASPECT, cellWidth, cellHeight);
    const score = fitted.width * fitted.height;
    if (!best || score > best.score + 1e-9)
      best = { cols, rows, cellWidth, cellHeight, score };
  }
  const { cols, rows, cellWidth, cellHeight } = best;
  return { cols, rows, cellWidth, cellHeight };
}

/** 비율 aspect(가로/세로)인 사진을 boxW×boxH 안에 찌그러짐 없이 최대한 크게 넣은 크기 (contain) */
function containSize(aspect, boxW, boxH) {
  const width = Math.min(boxW, boxH * aspect);
  return { width, height: width / aspect };
}

/**
 * 한 페이지의 사진들을 고정 그리드 슬롯에 배치한다.
 * - 모든 슬롯은 같은 크기(grid.cellWidth × grid.cellHeight) — 사진 비율/해상도와 무관하게 배치 칸이 같다.
 * - 각 사진은 슬롯 안에서 원본 비율을 유지한 채 최대한 크게(contain), 남는 공간은 여백으로 두고 가운데 정렬.
 * - 장수가 그리드보다 적은 페이지는 사용하는 행에 장수를 고르게 나누고(예: 3열에 4장 → 2+2),
 *   각 행은 가로 가운데, 행 묶음 전체는 세로 가운데 정렬 — 슬롯 크기는 그대로.
 */
function arrangePage(aspects, grid, area, gap) {
  const { cols, cellWidth, cellHeight } = grid;
  const rowCount = Math.ceil(aspects.length / cols);
  const rowSizes = splitIntoPages(aspects.length, cols).slice(0, rowCount); // 행별 장수를 고르게

  const blockHeight = rowCount * cellHeight + gap * (rowCount - 1);
  let y = area.y + (area.height - blockHeight) / 2;
  let index = 0;
  const slots = [];

  for (const size of rowSizes) {
    const rowWidth = size * cellWidth + gap * (size - 1);
    let x = area.x + (area.width - rowWidth) / 2;
    for (let i = 0; i < size; i++, index++) {
      const cell = { x, y, width: cellWidth, height: cellHeight };
      const fitted = containSize(aspects[index], cellWidth, cellHeight);
      slots.push({
        index,
        x: cell.x + (cellWidth - fitted.width) / 2,
        y: cell.y + (cellHeight - fitted.height) / 2,
        width: fitted.width,
        height: fitted.height,
        cell,
      });
      x += cellWidth + gap;
    }
    y += cellHeight + gap;
  }

  return slots;
}

/**
 * @param {{width:number, height:number}[]} sizes  EXIF 회전 적용 후 크기(px) — 배치 순서대로
 * @param {number} perPage  페이지당 최대 장수 (3~6)
 * @returns {{title, frame, table: {x,y,width,height}, grid: {cols,rows,cellWidth,cellHeight},
 *            pages:{slots:{index,x,y,width,height,cell}[]}[]}}
 *   frame은 사진을 감싸는 직사각형 테두리, table은 frame 안쪽 하단에 붙은 정보 표
 *   (frame과 좌/우/하단 선을 공유). slots[]의 x/y/width/height는 슬롯(cell) 안에 contain으로
 *   맞춘 실제 사진 위치, index는 sizes 배열의 인덱스. 단위는 mm.
 */
function computeLayout(sizes, perPage) {
  const L = LAYOUT;
  const title = {
    x: L.marginX,
    y: L.titleTop,
    width: L.pageWidth - L.marginX * 2,
    height: L.titleHeight,
  };
  const frameTop = L.titleTop + L.titleHeight + L.titleGap;
  const frame = {
    x: L.marginX,
    y: frameTop,
    width: L.pageWidth - L.marginX * 2,
    height: L.pageHeight - L.marginBottom - frameTop,
  };
  const table = {
    x: frame.x,
    y: frame.y + frame.height - L.tableHeight,
    width: frame.width,
    height: L.tableHeight,
  };
  const area = {
    x: frame.x + L.padding,
    y: frame.y + L.padding,
    width: frame.width - L.padding * 2,
    height: table.y - L.padding - (frame.y + L.padding),
  };

  const grid = chooseGrid(perPage, area, L.gap);
  const pages = [];
  let start = 0;
  for (const count of splitIntoPages(sizes.length, perPage)) {
    const aspects = sizes
      .slice(start, start + count)
      .map((s) => s.width / s.height);
    const slots = arrangePage(aspects, grid, area, L.gap).map((slot) =>
      Object.assign(slot, { index: start + slot.index }),
    );
    pages.push({ slots });
    start += count;
  }
  return { title, frame, table, grid, pages };
}

// ===================================================================
// 이미지 처리 — EXIF 회전 + 비율 유지 축소 (canvas)
// ===================================================================

// 2×1px, EXIF Orientation 6 JPEG. 브라우저가 EXIF를 자동 적용하면 1×2로 읽힌다.
const ORIENTATION_TEST_JPEG =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wBDAFA3PEY8MlBGQUZaVVBfeMiCeG5uePWvuZHI////////////////////////////////////////////////////2wBDAVVaWnhpeOuCguv/////////////////////////////////////////////////////////////////////////wAARCAABAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwC7RRRQB//Z";

/** 최신 브라우저는 <img>를 그릴 때 EXIF 방향을 자동 적용한다. 구형 브라우저면 직접 회전한다. */
const browserAppliesExif = loadImage(ORIENTATION_TEST_JPEG)
  .then((img) => img.naturalWidth === 1 && img.naturalHeight === 2)
  .catch(() => false);

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("이미지를 디코딩할 수 없습니다."));
    img.src = src;
  });
}

async function loadImageFromFile(file) {
  const url = URL.createObjectURL(file);
  try {
    return await loadImage(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("이미지 변환에 실패했습니다.")),
      type,
      quality,
    );
  });
}

function createCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return { canvas, ctx };
}

/** 사용이 끝난 canvas의 픽셀 메모리를 즉시 반환한다. */
function releaseCanvas(canvas) {
  canvas.width = 0;
  canvas.height = 0;
}

/** img를 EXIF 방향대로 돌려 canvas의 (0,0,w,h)에 그린다. w, h는 회전 후(보이는 방향) 크기. */
function drawOriented(ctx, img, orientation, w, h, autoApplied) {
  if (autoApplied || orientation === 1) {
    ctx.drawImage(img, 0, 0, w, h);
    return;
  }
  ctx.save();
  switch (orientation) {
    case 2:
      ctx.transform(-1, 0, 0, 1, w, 0);
      break; // 좌우 반전
    case 3:
      ctx.transform(-1, 0, 0, -1, w, h);
      break; // 180도
    case 4:
      ctx.transform(1, 0, 0, -1, 0, h);
      break; // 상하 반전
    case 5:
      ctx.transform(0, 1, 1, 0, 0, 0);
      break; // 전치
    case 6:
      ctx.transform(0, 1, -1, 0, w, 0);
      break; // 시계 방향 90도
    case 7:
      ctx.transform(0, -1, -1, 0, w, h);
      break; // 역전치
    case 8:
      ctx.transform(0, -1, 1, 0, 0, h);
      break; // 반시계 방향 90도
  }
  // 90도 회전이 들어간 방향(5~8)은 원본을 가로/세로 바꿔서 그린다.
  if (orientation >= 5) ctx.drawImage(img, 0, 0, h, w);
  else ctx.drawImage(img, 0, 0, w, h);
  ctx.restore();
}

/**
 * 사진을 EXIF 방향대로 세우고 outW×outH로 축소한 canvas를 만든다.
 * 한 번에 크게 줄이면 계단 현상이 생기므로 2배씩 단계적으로 줄인다.
 */
async function renderImage(entry, outW, outH) {
  const img = await loadImageFromFile(entry.file);
  const autoApplied = await browserAppliesExif;
  const { orientation, displayWidth, displayHeight } = entry.info;

  // 첫 단계: 최종 크기의 2^k배 중 원본을 넘지 않는 가장 큰 크기로 회전과 함께 그린다.
  let w = outW;
  let h = outH;
  while (w * 2 <= displayWidth && h * 2 <= displayHeight) {
    w *= 2;
    h *= 2;
  }
  let { canvas, ctx } = createCanvas(w, h);
  drawOriented(ctx, img, orientation, w, h, autoApplied);

  while (w > outW) {
    w = Math.max(outW, Math.round(w / 2));
    h = Math.max(outH, Math.round(h / 2));
    const next = createCanvas(w, h);
    next.ctx.drawImage(canvas, 0, 0, w, h);
    releaseCanvas(canvas);
    ({ canvas, ctx } = next);
  }
  return canvas;
}

/** 실제로 디코딩되는지 확인한다 (헤더는 멀쩡하지만 본문이 깨진 파일 걸러내기). 실패 시 예외. */
async function verifyDecodable(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    await img.decode();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 배치될 크기(mm)에 맞는 JPEG 바이트를 만든다.
 * 축소만 하고(확대 금지) 가로/세로 같은 배율이라 비율이 유지된다.
 * 회전이 필요 없고 이미 충분히 작으면 원본 바이트를 그대로 쓴다 (재압축 손실 없음).
 */
async function prepareImageForPdf(entry, slot) {
  const { orientation, displayWidth, displayHeight } = entry.info;
  const pxPerMm = IMAGE_DPI / 25.4;
  const scale = Math.min(
    1,
    (slot.width * pxPerMm) / displayWidth,
    (slot.height * pxPerMm) / displayHeight,
  );
  if (orientation === 1 && scale === 1) {
    return new Uint8Array(await entry.file.arrayBuffer());
  }
  const canvas = await renderImage(
    entry,
    Math.max(1, Math.round(displayWidth * scale)),
    Math.max(1, Math.round(displayHeight * scale)),
  );
  const blob = await canvasToBlob(canvas, "image/jpeg", JPEG_QUALITY);
  releaseCanvas(canvas);
  return new Uint8Array(await blob.arrayBuffer());
}

// ===================================================================
// PDF 조립
// ===================================================================

function readMeta() {
  const value = (id) => $(id).value.trim();
  // 사용자가 "125,000원"처럼 쉼표/단위를 붙여 입력해도 한 번만 붙도록 먼저 떼어낸다.
  const total = value("meta-total")
    .replace(/,/g, "")
    .replace(/\s*원$/, "");
  return {
    account: value("meta-account"),
    user: value("meta-user"),
    type: value("meta-type"),
    month: `${value("meta-month")}월`,
    // 숫자면 천 단위 쉼표 (숫자가 아니면 입력한 그대로) + "원" 단위. 예) 125000 → 125,000원
    total: total
      ? `${/^\d+$/.test(total) ? Number(total).toLocaleString("ko-KR") : total}원`
      : "",
  };
}

/**
 * 한글 글자를 투명 배경 PNG로 그린다 (width×height mm 영역).
 * jsPDF 기본 폰트는 한글이 없으므로 시스템 한글 폰트로 canvas에 그려 이미지로 넣는다.
 * 선/칸 채우기는 jsPDF 벡터로 그리고, 이 이미지는 그 위에 글자만 얹는다.
 * @param {(ctx: CanvasRenderingContext2D, s: number) => void} draw  s = px/mm
 */
function renderTextLayer(width, height, draw) {
  const s = TEXT_PX_PER_MM;
  const { canvas, ctx } = createCanvas(
    Math.round(width * s),
    Math.round(height * s),
  );
  ctx.fillStyle = "#1e1e1e";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  draw(ctx, s);
  const dataUrl = canvas.toDataURL("image/png");
  releaseCanvas(canvas);
  return dataUrl;
}

/** 상단 가운데 "증 빙 서" 제목 */
function renderTitleImage(title) {
  return renderTextLayer(title.width, title.height, (ctx, s) => {
    ctx.font = `bold ${8 * s}px ${KOREAN_FONT}`;
    ctx.fillText(TITLE_TEXT, (title.width * s) / 2, (title.height * s) / 2);
  });
}

/**
 * 정보 표의 칸 위치(mm, 표 기준 상대 x). 선(drawFrameAndTable)과 글자(renderTableTextImage)가 함께 쓴다.
 * @returns {{key,label,x,labelWidth,valueX,valueWidth}[]}
 */
function footerCells(table) {
  const labelTotal = FOOTER_TEXT.labelWidth * FOOTER_COLUMNS.length;
  const weightSum = FOOTER_COLUMNS.reduce((sum, col) => sum + col.weight, 0);
  let x = 0;
  return FOOTER_COLUMNS.map((col) => {
    const valueWidth = ((table.width - labelTotal) * col.weight) / weightSum;
    const cell = {
      key: col.key,
      label: col.label,
      x,
      labelWidth: FOOTER_TEXT.labelWidth,
      valueX: x + FOOTER_TEXT.labelWidth,
      valueWidth,
    };
    x += FOOTER_TEXT.labelWidth + valueWidth;
    return cell;
  });
}

/**
 * text가 maxWidthPx 안에 들어가도록 글씨 크기(px)를 sizePx에서 minPx까지 0.1mm씩 줄여 ctx.font에 설정한다.
 * @returns {number} 최종 글씨 크기(px)
 */
function fitFont(ctx, text, maxWidthPx, sizePx, minPx, s) {
  let size = sizePx;
  ctx.font = `${size}px ${KOREAN_FONT}`;
  while (size > minPx && ctx.measureText(text).width > maxWidthPx) {
    size = Math.max(minPx, size - 0.1 * s);
    ctx.font = `${size}px ${KOREAN_FONT}`;
  }
  return size;
}

/** 정보 표의 글자 — 1줄, 칸마다 라벨(작게, 가운데)과 값(가운데)을 나란히 */
function renderTableTextImage(table, meta) {
  return renderTextLayer(table.width, table.height, (ctx, s) => {
    const cy = (table.height * s) / 2;
    const pad = FOOTER_TEXT.padding * s;
    for (const cell of footerCells(table)) {
      const labelMax = cell.labelWidth * s - pad * 2;
      fitFont(
        ctx,
        cell.label,
        labelMax,
        FOOTER_TEXT.labelSize * s,
        FOOTER_TEXT.minSize * s,
        s,
      );
      ctx.fillText(
        cell.label,
        (cell.x + cell.labelWidth / 2) * s,
        cy,
        labelMax,
      );

      const value = meta[cell.key] || "";
      const valueMax = cell.valueWidth * s - pad * 2;
      fitFont(
        ctx,
        value,
        valueMax,
        FOOTER_TEXT.valueSize * s,
        FOOTER_TEXT.minSize * s,
        s,
      );
      // maxWidth: 최소 글씨로도 넘치는 극단적인 값은 잘리지 않고 가로로 눌러서 칸 안에 넣는다.
      ctx.fillText(
        value,
        (cell.valueX + cell.valueWidth / 2) * s,
        cy,
        valueMax,
      );
    }
  });
}

/**
 * 사진을 감싸는 직사각형 테두리 + 그 하단 선을 공유하는 정보 표의 선/배경을 벡터로 그린다.
 * 표는 별도 테두리 없이 frame의 좌/우/하단 선을 그대로 쓰고, 위쪽 가로선·칸 구분선만 추가한다 (1줄 구조).
 */
function drawFrameAndTable(doc, frame, table) {
  const cells = footerCells(table);

  doc.setFillColor(238, 240, 243); // 라벨 칸 배경
  for (const cell of cells)
    doc.rect(table.x + cell.x, table.y, cell.labelWidth, table.height, "F");

  doc.setDrawColor(40);
  cells.forEach((cell, i) => {
    doc.setLineWidth(0.2); // 라벨 | 값
    doc.line(
      table.x + cell.valueX,
      table.y,
      table.x + cell.valueX,
      table.y + table.height,
    );
    if (i > 0) {
      doc.setLineWidth(0.3); // 칸 | 칸
      doc.line(
        table.x + cell.x,
        table.y,
        table.x + cell.x,
        table.y + table.height,
      );
    }
  });

  doc.setLineWidth(0.5);
  doc.line(table.x, table.y, table.x + table.width, table.y); // 사진 영역과 표 경계
  doc.rect(frame.x, frame.y, frame.width, frame.height, "S"); // 바깥 테두리
}

/** 화면 갱신(진행 표시)이 보이도록 한 프레임 양보한다. */
function nextFrame() {
  return new Promise((resolve) =>
    requestAnimationFrame(() => setTimeout(resolve, 0)),
  );
}

async function buildPdf(entries, perPage, meta) {
  const { jsPDF } = window.jspdf;
  const layout = computeLayout(
    entries.map((e) => ({
      width: e.info.displayWidth,
      height: e.info.displayHeight,
    })),
    perPage,
  );
  const doc = new jsPDF({
    orientation: "landscape",
    unit: "mm",
    format: "a4",
    compress: true,
  });
  const { title, frame, table } = layout;
  const titleImage = renderTitleImage(title);
  const tableTextImage = renderTableTextImage(table, meta);
  let done = 0;

  for (let p = 0; p < layout.pages.length; p++) {
    if (p > 0) doc.addPage("a4", "landscape");

    // 같은 alias로 넣으면 PDF 안에 제목/표 글자 이미지가 한 번만 저장된다.
    doc.addImage(
      titleImage,
      "PNG",
      title.x,
      title.y,
      title.width,
      title.height,
      "title",
    );
    drawFrameAndTable(doc, frame, table);
    doc.addImage(
      tableTextImage,
      "PNG",
      table.x,
      table.y,
      table.width,
      table.height,
      "table-text",
    );

    for (const slot of layout.pages[p].slots) {
      showStatus(`이미지 정리 중... (${done + 1}/${entries.length})`);
      await nextFrame();
      const data = await prepareImageForPdf(entries[slot.index], slot);
      doc.addImage(
        data,
        "JPEG",
        slot.x,
        slot.y,
        slot.width,
        slot.height,
        undefined,
        "NONE",
      );
      done++;
    }

    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text(
      `${p + 1} / ${layout.pages.length}`,
      frame.x + frame.width,
      LAYOUT.pageHeight - 5,
      {
        align: "right",
      },
    );
  }

  showStatus("PDF 생성 중...");
  await nextFrame();
  return doc.output("blob");
}

// ===================================================================
// UI
// ===================================================================

function showStatus(text) {
  els.statusText.textContent = text;
  els.status.hidden = false;
}

function hideStatus() {
  els.status.hidden = true;
}

/** 오류를 인라인으로 표시한다. 여러 줄(파일별 사유)을 받을 수 있다. */
function showError(message) {
  hideStatus();
  els.errorText.textContent = message;
  els.error.hidden = false;
}

function hideError() {
  els.error.hidden = true;
}

function updateFileSummary() {
  const count = state.files.length;
  els.fileCount.textContent =
    count > 0
      ? `${count}장 업로드됨`
      : "최소 1장 이상의 영수증 사진을 업로드해주세요.";
  els.fileCount.classList.toggle("has-files", count > 0);
  els.generateBtn.disabled =
    count === 0 ||
    state.loading ||
    state.phase === "generating" ||
    !window.jspdf;
}

/** 파일 검증 결과를 PRD 메시지별로 묶어 "메시지 (파일명, 파일명)" 형태로 만든다. */
function summarizeRejections(rejections) {
  const byMessage = new Map();
  for (const { message, name } of rejections) {
    if (!byMessage.has(message)) byMessage.set(message, []);
    byMessage.get(message).push(name);
  }
  return [...byMessage]
    .map(([message, names]) => `${message} (${names.join(", ")})`)
    .join("\n");
}

/** 업로드된 파일들을 검증해 state.files에 추가한다. 문제 있는 파일만 제외하고 나머지는 계속 진행. */
async function addFiles(fileList) {
  const files = Array.from(fileList);
  if (files.length === 0) return;

  state.loading = true;
  hideError();
  updateFileSummary();
  const rejections = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    showStatus(`사진 확인 중... (${i + 1}/${files.length})`);

    if (!/\.jpe?g$/i.test(file.name)) {
      rejections.push({ message: MESSAGES.invalidType, name: file.name });
      continue;
    }
    if (state.files.length >= MAX_FILES) {
      rejections.push({
        message: `${MESSAGES.limitExceeded} (최대 ${MAX_FILES}장)`,
        name: file.name,
      });
      continue;
    }
    if (file.size > MAX_FILE_SIZE) {
      rejections.push({
        message: `${MESSAGES.limitExceeded} (장당 20MB)`,
        name: file.name,
      });
      continue;
    }

    const entry = { id: state.nextId++, file, name: file.name, info: null };
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!isJpeg(bytes)) {
        rejections.push({ message: MESSAGES.invalidType, name: file.name });
        continue;
      }
      entry.info = readJpegInfo(bytes);
      await verifyDecodable(file);
    } catch (err) {
      console.warn(file.name, err);
      rejections.push({ message: MESSAGES.corrupted, name: file.name });
      continue;
    }

    state.files.push(entry);
    updateFileSummary();
  }

  state.loading = false;
  if (state.files.length > 0 && state.phase === "idle")
    state.phase = "files_selected";
  hideStatus();
  updateFileSummary();
  if (rejections.length > 0) showError(summarizeRejections(rejections));
}

function handleFiles(fileList) {
  const files = Array.from(fileList); // FileList는 input 초기화 시 비워지므로 복사
  loadQueue = loadQueue
    .then(() => addFiles(files))
    .catch((err) => {
      console.error(err);
      state.loading = false;
      showError(MESSAGES.corrupted);
      updateFileSummary();
    });
}

/** 필수 항목이 비어 있으면 첫 번째 누락 항목을 alert로 알리고 포커스한 뒤 false를 반환한다. */
function validateRequiredFields() {
  for (const { id, message } of REQUIRED_FIELDS) {
    const input = $(id);
    if (input.value.trim() === "") {
      alert(message);
      input.focus();
      return false;
    }
  }
  return true;
}

/**
 * 계정과목에 따라 다운로드 파일명을 정한다.
 * "식비"/"교통비"가 포함되면 그 이름으로, 그 외에는 입력값을 그대로 괄호 안에 넣는다.
 * 파일명에 쓸 수 없는 문자(\ / : * ? " < > |, 제어 문자)는 "_"로 바꾼다.
 */
function pdfFileName(account) {
  let label;
  if (account.includes("식비")) label = "식비";
  else if (account.includes("교통비")) label = "교통비";
  else label = account.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
  return `출장_사용비용_증빙서(${label}).pdf`;
}

/** EXIF 회전 → 리사이즈 → 페이지 배치 → jsPDF로 PDF 생성 → 미리보기/다운로드 연결. */
async function generatePdf() {
  if (!validateRequiredFields()) return;
  if (state.files.length === 0) {
    showError(MESSAGES.noFiles);
    return;
  }
  if (!window.jspdf) {
    showError(MESSAGES.libraryMissing);
    return;
  }

  state.phase = "generating";
  hideError();
  updateFileSummary();

  try {
    const meta = readMeta();
    const blob = await buildPdf(
      state.files.slice(),
      Number(els.perPage.value),
      meta,
    );
    if (state.pdfUrl) URL.revokeObjectURL(state.pdfUrl);
    state.pdfUrl = URL.createObjectURL(blob);
    els.pdfPreview.src = state.pdfUrl;
    els.downloadBtn.href = state.pdfUrl;
    els.downloadBtn.download = pdfFileName(meta.account);
    els.resultSection.hidden = false;
    state.phase = "done";
    hideStatus();
    els.resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    console.error(err);
    state.phase = "error";
    showError(MESSAGES.generateFailed);
  } finally {
    updateFileSummary();
  }
}

/** 모든 상태를 초기화하고 처음 화면으로 돌아간다. */
function resetAll() {
  if (state.loading) return;
  if (state.pdfUrl) URL.revokeObjectURL(state.pdfUrl);
  state.phase = "idle";
  state.files = [];
  state.pdfUrl = null;
  els.metaForm.reset();
  els.resultSection.hidden = true;
  els.pdfPreview.removeAttribute("src");
  els.downloadBtn.removeAttribute("href");
  els.downloadBtn.removeAttribute("download");
  hideStatus();
  hideError();
  updateFileSummary();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ===== 이벤트 바인딩 =====
els.fileInput.addEventListener("change", (e) => {
  handleFiles(e.target.files);
  e.target.value = ""; // 같은 파일 재선택 허용
});

["dragenter", "dragover"].forEach((type) => {
  els.dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    els.dropzone.classList.add("is-dragover");
  });
});

["dragleave", "drop"].forEach((type) => {
  els.dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    els.dropzone.classList.remove("is-dragover");
  });
});

els.dropzone.addEventListener("drop", (e) => {
  if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files);
});

// 업로드 영역 밖에 파일을 떨어뜨려도 브라우저가 그 파일을 열며 페이지를 떠나지 않게 막는다.
["dragover", "drop"].forEach((type) => {
  window.addEventListener(type, (e) => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes("Files"))
      e.preventDefault();
  });
});

els.errorDismiss.addEventListener("click", hideError);
els.generateBtn.addEventListener("click", generatePdf);
els.resetBtn.addEventListener("click", resetAll);

// ===== 초기화 =====
if (!window.jspdf) showError(MESSAGES.libraryMissing);
updateFileSummary();
