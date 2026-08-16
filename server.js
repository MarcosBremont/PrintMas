const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const express = require('express');
const cors = require('cors');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// ---------------------------------------------------------------------------
// Configuración de precios (fuente única de verdad, también expuesta al front
// en /api/config para que el cotizador del cliente use los mismos valores).
// ---------------------------------------------------------------------------
const PRICING = {
  bwPage: Number(process.env.PRICE_BW_PAGE || 1.5),      // costo por página Blanco/Negro
  colorPage: Number(process.env.PRICE_COLOR_PAGE || 5),   // costo por página Color
  currency: process.env.CURRENCY || 'MXN'
};

const DEFAULT_PRINTER = process.env.PRINTER_NAME || null; // null = impresora predeterminada del SO

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Multer: almacenamiento temporal en disco, solo PDFs
// ---------------------------------------------------------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const id = crypto.randomUUID();
    cb(null, `${id}.pdf`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
  fileFilter: (req, file, cb) => {
    const isPdf = file.mimetype === 'application/pdf' &&
      path.extname(file.originalname).toLowerCase() === '.pdf';
    if (!isPdf) return cb(new Error('Solo se permiten archivos PDF'));
    cb(null, true);
  }
});

// ---------------------------------------------------------------------------
// GET /api/config -> valores de cotización para el frontend
// ---------------------------------------------------------------------------
app.get('/api/config', (req, res) => {
  res.json({ pricing: PRICING });
});

// ---------------------------------------------------------------------------
// Validación de rango de páginas: "1-3,5,8-9"
// ---------------------------------------------------------------------------
const PAGE_RANGE_REGEX = /^\d+(-\d+)?(,\s*\d+(-\d+)?)*$/;

function parseOrderFields(body) {
  const pageMode = body.pageMode === 'range' ? 'range' : 'all';
  const pageRange = (body.pageRange || '').trim();
  const copies = Math.min(Math.max(parseInt(body.copies, 10) || 1, 1), 99);
  const colorMode = body.colorMode === 'color' ? 'color' : 'bw';
  const orientation = body.orientation === 'landscape' ? 'landscape' : 'portrait';
  const totalPages = parseInt(body.totalPages, 10) || 0;

  if (pageMode === 'range' && !PAGE_RANGE_REGEX.test(pageRange)) {
    throw new Error('Rango de páginas inválido. Usa el formato "1-3,5,8-9".');
  }

  return { pageMode, pageRange, copies, colorMode, orientation, totalPages };
}

// ---------------------------------------------------------------------------
// Envío a la cola de impresión del sistema operativo
// ---------------------------------------------------------------------------
function printOnWindows(filePath, order) {
  // pdf-to-printer usa SumatraPDF internamente; requiere Windows.
  const { print } = require('pdf-to-printer');
  const options = {
    printer: DEFAULT_PRINTER || undefined,
    copies: order.copies,
    orientation: order.orientation, // 'portrait' | 'landscape'
    monochrome: order.colorMode === 'bw'
  };
  if (order.pageMode === 'range') {
    options.pages = order.pageRange;
  }
  return print(filePath, options);
}

function printOnLinux(filePath, order) {
  return new Promise((resolve, reject) => {
    const args = [];
    if (DEFAULT_PRINTER) args.push('-d', DEFAULT_PRINTER);
    args.push('-n', String(order.copies));

    if (order.pageMode === 'range') {
      args.push('-P', order.pageRange);
    }

    // orientation-requested (IPP estándar): 3 = portrait, 4 = landscape
    const orientationCode = order.orientation === 'landscape' ? '4' : '3';
    args.push('-o', `orientation-requested=${orientationCode}`);

    // Dependiente del driver/PPD de la impresora; ajustar según el modelo real.
    args.push('-o', order.colorMode === 'bw' ? 'ColorModel=Gray' : 'ColorModel=RGB');

    args.push(filePath);

    execFile('lp', args, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr || error.message));
      resolve(stdout);
    });
  });
}

async function sendToPrinter(filePath, order) {
  if (process.platform === 'win32') {
    return printOnWindows(filePath, order);
  }
  return printOnLinux(filePath, order);
}

// ---------------------------------------------------------------------------
// POST /api/upload -> recibe PDF + configuración, imprime y borra el archivo
// ---------------------------------------------------------------------------
app.post('/api/upload', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No se recibió ningún archivo PDF.' });
    }

    const filePath = req.file.path;
    const orderId = path.basename(filePath, '.pdf');

    let order;
    try {
      order = parseOrderFields(req.body);
    } catch (validationError) {
      await safeDelete(filePath);
      return res.status(400).json({ success: false, message: validationError.message });
    }

    try {
      await sendToPrinter(filePath, order);
      res.json({
        success: true,
        orderId,
        message: 'Documento enviado a la cola de impresión correctamente.'
      });
    } catch (printError) {
      console.error(`[${orderId}] Error al imprimir:`, printError.message);
      res.status(500).json({
        success: false,
        message: 'No se pudo enviar el documento a la impresora. Intenta de nuevo o solicita ayuda.'
      });
    } finally {
      // Limpieza inmediata por privacidad, sin importar el resultado.
      await safeDelete(filePath);
    }
  });
});

function safeDelete(filePath) {
  return fs.promises.unlink(filePath).catch((e) => {
    console.error('No se pudo borrar el archivo temporal:', e.message);
  });
}

app.listen(PORT, () => {
  console.log(`PrintMas Kiosko escuchando en http://localhost:${PORT}`);
  console.log(`Plataforma detectada: ${process.platform}`);
  console.log(`Impresora configurada: ${DEFAULT_PRINTER || '(predeterminada del sistema)'}`);
});
