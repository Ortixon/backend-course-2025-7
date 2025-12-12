const fs = require('fs');
const path = require('path');
const { program } = require('commander');
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const crypto = require('crypto');
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('./swagger.json'); 
// 👇 1. Додали бібліотеку для бази даних
const mysql = require('mysql2/promise');

// --- НАЛАШТУВАННЯ АРГУМЕНТІВ ---
program
  .requiredOption('-h, --host <type>', 'Адреса сервера')
  .requiredOption('-p, --port <type>', 'Порт сервера')
  .requiredOption('-c, --cache <type>', 'Шлях до директорії кешу');

program.parse(process.argv);
const options = program.opts();
const serverHost = options.host;
const serverPort = options.port;
const cacheDir = path.resolve(options.cache);

// --- СТВОРЕННЯ КЕШ-ПАПКИ ---
if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir, { recursive: true });
}

// 👇 2. Підключення до Бази Даних
// Беремо дані з .env або ставимо стандартні для Docker
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'db',       // 'db' - це назва сервісу в docker-compose
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD,       // Пароль з .env
  database: process.env.DB_NAME,           // Ім'я бази з .env
  port: 3306,                              // ⚠️ Внутрішній порт Docker (не 3307!)
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

// --- API МЕТОДИ (ПЕРЕПИСАНІ ПІД SQL) ---

// 1. Створення товару
app.post('/register', upload.single('photo'), async (req, res) => {
  try {
    if (!req.body.inventory_name) {
      return res.status(400).send('"inventory_name" is required');
    }
    
    // Підготовка даних
    const id = crypto.randomUUID(); // Генеруємо ID самі (або можна використовувати Auto Increment бази)
    const name = req.body.inventory_name;
    const description = req.body.description || '';
    const photoPath = req.file ? req.file.path : null;
    const photoUrl = req.file ? `/inventory/${id}/photo` : null;

    // 👇 SQL запит замість db.push
    const sql = `INSERT INTO items (id, name, description, photo_path, photo_url) VALUES (?, ?, ?, ?, ?)`;
    // Якщо у тебе в базі поле id - це INT auto_increment, прибери id з запиту.
    // Але судячи з коду, ти хочеш UUID, тому передаємо його як рядок.
    
    await pool.execute(sql, [id, name, description, photoPath, photoUrl]);

    // Повертаємо об'єкт, як він виглядає
    res.status(201).json({ id, name, description, photoPath, photoUrl });
  } catch (err) {
    console.error(err);
    res.status(500).send('Database Error');
  }
});

// 2. Пошук товару
app.post('/search', async (req, res) => {
  try {
    const { id } = req.body;
    // 👇 SQL запит
    const [rows] = await pool.execute('SELECT * FROM items WHERE id = ?', [id]);
    
    if (rows.length === 0) {
      return res.status(404).send('Not Found');
    }

    let result = rows[0]; // Беремо перший знайдений елемент

    // Логіка з фото (як було в твоєму коді)
    if (req.body.has_photo === 'true' && result.photo_url) {
       // Зверни увагу: поле в базі може називатися photo_url (snake_case) або photoUrl - перевір це
       // Я використовую photo_url як стандарт для SQL. Якщо в тебе camelCase - зміни тут.
       result.description = `${result.description} (Фото: ${result.photo_url})`;
    }
    res.status(201).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).send('Database Error');
  }
});

// 3. Отримати всі товари
app.get('/inventory', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM items');
    res.status(200).json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).send('Database Error');
  }
});

// 4. Робота з конкретним товаром (GET, PUT, DELETE)
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

      // Перевіряємо чи існує
      const [check] = await pool.execute('SELECT * FROM items WHERE id = ?', [id]);
      if (check.length === 0) return res.status(404).send('Not Found');

      // 👇 Динамічне оновлення (оновлюємо тільки те, що прийшло)
      // Для простоти оновимо обидва поля, якщо вони є
      if (name) await pool.execute('UPDATE items SET name = ? WHERE id = ?', [name, id]);
      if (description) await pool.execute('UPDATE items SET description = ? WHERE id = ?', [description, id]);

      // Отримуємо оновлену версію
      const [updated] = await pool.execute('SELECT * FROM items WHERE id = ?', [id]);
      res.status(200).json(updated[0]);
    } catch (err) {
      res.status(500).send(err.message);
    }
  })
  .delete(async (req, res) => {
    try {
      // Спочатку знайдемо файл, щоб видалити його (опціонально)
      const [rows] = await pool.execute('SELECT photo_path FROM items WHERE id = ?', [req.params.id]);
      
      const [result] = await pool.execute('DELETE FROM items WHERE id = ?', [req.params.id]);
      
      if (result.affectedRows === 0) {
        return res.status(404).send('Not Found');
      }

      // Якщо треба видаляти і файл з диска:
      if (rows.length > 0 && rows[0].photo_path && fs.existsSync(rows[0].photo_path)) {
         try { fs.unlinkSync(rows[0].photo_path); } catch(e) {}
      }

      res.status(200).send('Deleted');
    } catch (err) {
      res.status(500).send(err.message);
    }
  })
  .all((req, res) => res.status(405).send('Method Not Allowed'));

// 5. Робота з фото
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

      // Видаляємо старе фото
      const oldPath = rows[0].photo_path;
      if (oldPath && fs.existsSync(oldPath)) {
          try { fs.unlinkSync(oldPath); } catch(e) {}
      }
      
      const newPath = req.file.path;
      const newUrl = `/inventory/${id}/photo`;

      await pool.execute('UPDATE items SET photo_path = ?, photo_url = ? WHERE id = ?', [newPath, newUrl, id]);
      
      // Повертаємо оновлений об'єкт
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

// Запуск сервера
app.listen(serverPort, serverHost, () => {
  console.log(`Сервер запущено : http://${serverHost}:${serverPort}`);
  console.log(`Документація Swagger: http://${serverHost}:${serverPort}/docs`);
  console.log(`Директорія кешу: ${cacheDir}`);
}); 