const fs = require('fs');
const path = require('path');
const { program } = require('commander');
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const crypto = require('crypto');
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('./swagger.json'); 
const mysql = require('mysql2/promise');

program
  .requiredOption('-h, --host <type>', 'Адреса сервера')
  .requiredOption('-p, --port <type>', 'Порт сервера')
  .requiredOption('-c, --cache <type>', 'Шлях до директорії кешу');

program.parse(process.argv);
const options = program.opts();
const serverHost = options.host;
const serverPort = options.port;
const cacheDir = path.resolve(options.cache);

if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir, { recursive: true });
}


const pool = mysql.createPool({
  host: process.env.DB_HOST || 'db',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,       
  port: 3306,                             
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

const app = express();

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

app.post('/register', upload.single('photo'), async (req, res) => {
  try {
    if (!req.body.inventory_name) {
      return res.status(400).send('"inventory_name" is required');
    }
    
    const id = crypto.randomUUID();
    const name = req.body.inventory_name;
    const description = req.body.description || '';
    const photoPath = req.file ? req.file.path : null;
    const photoUrl = req.file ? `/inventory/${id}/photo` : null;

    const sql = `INSERT INTO items (id, name, description, photo_path, photo_url) VALUES (?, ?, ?, ?, ?)`;
    
    await pool.execute(sql, [id, name, description, photoPath, photoUrl]);

    res.status(201).json({ id, name, description, photoPath, photoUrl });
  } catch (err) {
    console.error(err);
    res.status(500).send('Database Error');
  }
});
app.post('/search', async (req, res) => {
  try {
    const { id } = req.body;
    const [rows] = await pool.execute('SELECT * FROM items WHERE id = ?', [id]);
    
    if (rows.length === 0) {
      return res.status(404).send('Not Found');
    }

    let result = rows[0];

    if (req.body.has_photo === 'true' && result.photo_url) {
       result.description = `${result.description} (Фото: ${result.photo_url})`;
    }
    res.status(201).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).send('Database Error');
  }
});

app.get('/inventory', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM items');
    res.status(200).json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).send('Database Error');
  }
});

app.route('/inventory/:id')
  .get(async (req, res) => {
    try {
      const [rows] = await pool.execute('SELECT * FROM items WHERE id = ?', [req.params.id]);
      return rows.length > 0 ? res.status(200).json(rows[0]) : res.status(404).send('Not Found');
    } catch (err) {
      res.status(500).send(err.message);
    }
  })
  .put(async (req, res) => {
    try {
      const { name, description } = req.body;
      const id = req.params.id;

      const [check] = await pool.execute('SELECT * FROM items WHERE id = ?', [id]);
      if (check.length === 0) return res.status(404).send('Not Found');

      if (name) await pool.execute('UPDATE items SET name = ? WHERE id = ?', [name, id]);
      if (description) await pool.execute('UPDATE items SET description = ? WHERE id = ?', [description, id]);

      const [updated] = await pool.execute('SELECT * FROM items WHERE id = ?', [id]);
      res.status(200).json(updated[0]);
    } catch (err) {
      res.status(500).send(err.message);
    }
  })
  .delete(async (req, res) => {
    try {
      const [rows] = await pool.execute('SELECT photo_path FROM items WHERE id = ?', [req.params.id]);
      
      const [result] = await pool.execute('DELETE FROM items WHERE id = ?', [req.params.id]);
      
      if (result.affectedRows === 0) {
        return res.status(404).send('Not Found');
      }

      if (rows.length > 0 && rows[0].photo_path && fs.existsSync(rows[0].photo_path)) {
         try { fs.unlinkSync(rows[0].photo_path); } catch(e) {}
      }

      res.status(200).send('Deleted');
    } catch (err) {
      res.status(500).send(err.message);
    }
  })
  .all((req, res) => res.status(405).send('Method Not Allowed'));

app.route('/inventory/:id/photo')
  .get(async (req, res) => {
    try {
      const [rows] = await pool.execute('SELECT photo_path FROM items WHERE id = ?', [req.params.id]);
      if (rows.length === 0 || !rows[0].photo_path || !fs.existsSync(rows[0].photo_path)) {
        return res.status(404).send('Photo Not Found');
      }
      res.setHeader('Content-Type', 'image/jpeg');
      res.sendFile(rows[0].photo_path);
    } catch (err) {
      res.status(500).send(err.message);
    }
  })
  .put(upload.single('photo'), async (req, res) => {
    try {
      const id = req.params.id;
      const [rows] = await pool.execute('SELECT * FROM items WHERE id = ?', [id]);
      
      if (rows.length === 0) return res.status(404).send('Not Found');
      if (!req.file) return res.status(400).send('File not uploaded');

      const oldPath = rows[0].photo_path;
      if (oldPath && fs.existsSync(oldPath)) {
          try { fs.unlinkSync(oldPath); } catch(e) {}
      }
      
      const newPath = req.file.path;
      const newUrl = `/inventory/${id}/photo`;

      await pool.execute('UPDATE items SET photo_path = ?, photo_url = ? WHERE id = ?', [newPath, newUrl, id]);
      
      const [updated] = await pool.execute('SELECT * FROM items WHERE id = ?', [id]);
      res.status(200).json(updated[0]);

    } catch (err) {
      res.status(500).send(err.message);
    }
  })
  .all((req, res) => res.status(405).send('Method Not Allowed'));

app.use((req, res) => {
  res.status(404).send('404 - Endpoint Not Found');
});

app.listen(serverPort, serverHost, () => {
  console.log(`Сервер запущено : http://${serverHost}:${serverPort}`);
  console.log(`Документація Swagger: http://${serverHost}:${serverPort}/docs`);
  console.log(`Директорія кешу: ${cacheDir}`);
}); 