const fs = require('fs');
const path = require('path');
const { program } = require('commander');
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const crypto = require('crypto');
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('./swagger.json'); 

program
  .requiredOption('-h, --host <type>', 'Адреса сервера')
  .requiredOption('-p, --port <type>', 'Порт сервера')
  .requiredOption('-c, --cache <type>', 'Шлях до директорії кешу');

program.parse(process.argv);
const options = program.opts();
const host = options.host;
const port = options.port;
const cacheDir = path.resolve(options.cache);

if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir, { recursive: true });
}

const app = express();
const db = [];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, cacheDir),
  filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

const findItem = (id) => db.find(i => i.id === id);
const findIndex = (id) => db.findIndex(i => i.id === id);

app.post('/register', upload.single('photo'), (req, res) => {
  if (!req.body.inventory_name) {
    return res.status(400).send('"inventory_name" is required');
  }
  const id = crypto.randomUUID();
  const newItem = {
    id: id,
    name: req.body.inventory_name,
    description: req.body.description || '',
    photoPath: req.file ? req.file.path : null,
    photoUrl: req.file ? `/inventory/${id}/photo` : null
  };
  db.push(newItem);
  res.status(201).json(newItem);
});

app.post('/search', (req, res) => {
  const item = findItem(req.body.id);
  if (!item) {
    return res.status(404).send('Not Found');
  }
  let result = { ...item };
  if (req.body.has_photo === 'true' && result.photoUrl) {
    result.description = `${result.description} (Фото: ${result.photoUrl})`;
  }
  res.status(201).json(result);
});

app.get('/inventory', (req, res) => {
  res.status(200).json(db);
});

app.route('/inventory/:id')
  .get((req, res) => {
    const item = findItem(req.params.id);
    return item ? res.status(200).json(item) : res.status(404).send('Not Found');
  })
  .put((req, res) => {
    const item = findItem(req.params.id);
    if (!item) {
      return res.status(404).send('Not Found');
    }
    if (req.body.name) item.name = req.body.name;
    if (req.body.description) item.description = req.body.description;
    res.status(200).json(item);
  })
  .delete((req, res) => {
    const index = findIndex(req.params.id);
    if (index === -1) {
      return res.status(404).send('Not Found');
    }
    db.splice(index, 1);
    res.status(200).send('Deleted');
  })
  .all((req, res) => res.status(405).send('Method Not Allowed'));

app.route('/inventory/:id/photo')
  .get((req, res) => {
    const item = findItem(req.params.id);
    if (!item || !item.photoPath || !fs.existsSync(item.photoPath)) {
      return res.status(404).send('Photo Not Found');
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.sendFile(item.photoPath);
  })
  .put(upload.single('photo'), (req, res) => {
    const item = findItem(req.params.id);
    if (!item) {
      return res.status(404).send('Not Found');
    }
    if (!req.file) {
      return res.status(400).send('File not uploaded');
    }
    if (item.photoPath && fs.existsSync(item.photoPath)) {
        try { fs.unlinkSync(item.photoPath); } catch(e) {}
    }
    
    item.photoPath = req.file.path;
    item.photoUrl = `/inventory/${item.id}/photo`;
    res.status(200).json(item);
  })
  .all((req, res) => res.status(405).send('Method Not Allowed'));

app.use((req, res) => {
  res.status(404).send('404 - Endpoint Not Found');
});

app.listen(port, host, () => {
  console.log(`Сервер запущено: http://${host}:${port}`);
  console.log(`Документація Swagger: http://${host}:${port}/docs`);
  console.log(`Директорія кешу: ${cacheDir}`);
});