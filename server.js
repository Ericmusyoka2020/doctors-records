const express = require('express');
const cors = require('cors');
const { createClient } = require('@libsql/client');

const app = express();
const router = express.Router();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-clinic-pin']
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'libsql://new-doctors-sharperloans.aws-eu-central-1.turso.io',
  authToken: process.env.TURSO_AUTH_TOKEN || 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3OTU0MzI0MzksImlkIjoiMDFhMjA4MTktYWEwMS03ODA2LThhZmQtYzc3NjY1YzUyYmI1Iiwia2lkIjoiRnR1czRyNjZsQlhYMWRKYWNoNmc4VzFtODBCenFzaFpvZ29FQkd1bGxIRSIsInJpZCI6IjcwNGU0OTliLTVhM2QtNDQxYS1hMjQ0LWZjZGFlOTMyMDViYyJ9.szEpQElthm8B5q6XnOmkXc4p6tzYikWvCyRzV9k8cy9e9DTlyUOpXszer-m8_jNgFHHW2WiDDcR20Ete9knFCg'
});

const CLINIC_PIN = process.env.CLINIC_PIN || '1234';

let schemaInitialized = false;

async function ensureSchema() {
  if (schemaInitialized) return;

  await db.batch([
    `CREATE TABLE IF NOT EXISTS patients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_number TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      phone TEXT,
      age TEXT,
      sex TEXT,
      blood_group TEXT,
      allergies TEXT,
      chronic_conditions TEXT,
      next_of_kin TEXT,
      residence TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL,
      visit_date TEXT DEFAULT (datetime('now')),
      vitals_bp TEXT,
      vitals_temp TEXT,
      vitals_pulse TEXT,
      vitals_weight TEXT,
      vitals_spo2 TEXT,
      symptoms TEXT,
      findings_tests_results TEXT,
      diagnosis TEXT,
      medication_given TEXT,
      doctor_lab_comments TEXT,
      follow_up_note TEXT,
      amount_charged REAL DEFAULT 0,
      amount_paid REAL DEFAULT 0,
      payment_mode TEXT,
      FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(full_name)`,
    `CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients(phone)`,
    `CREATE INDEX IF NOT EXISTS idx_patients_file ON patients(file_number)`,
    `CREATE INDEX IF NOT EXISTS idx_visits_patient ON visits(patient_id)`
  ], 'write');

  const info = await db.execute(`PRAGMA table_info(visits)`);
  const existingCols = new Set(info.rows.map(row => row.name));

  if (!existingCols.has('findings_tests_results')) {
    await db.execute(`ALTER TABLE visits ADD COLUMN findings_tests_results TEXT DEFAULT ''`);
    if (existingCols.has('examination')) {
      await db.execute(`UPDATE visits SET findings_tests_results = COALESCE(examination, '') WHERE findings_tests_results IS NULL OR findings_tests_results = ''`);
    }
  }

  if (!existingCols.has('medication_given')) {
    await db.execute(`ALTER TABLE visits ADD COLUMN medication_given TEXT DEFAULT ''`);
    if (existingCols.has('prescription')) {
      await db.execute(`UPDATE visits SET medication_given = COALESCE(prescription, '') WHERE medication_given IS NULL OR medication_given = ''`);
    }
  }

  if (!existingCols.has('doctor_lab_comments')) {
    await db.execute(`ALTER TABLE visits ADD COLUMN doctor_lab_comments TEXT DEFAULT ''`);
    if (existingCols.has('doctor_notes')) {
      await db.execute(`UPDATE visits SET doctor_lab_comments = COALESCE(doctor_notes, '') WHERE doctor_lab_comments IS NULL OR doctor_lab_comments = ''`);
    }
  }

  schemaInitialized = true;
}

function checkPin(req, res, next) {
  if (req.path === '/' || req.path === '/health' || req.path === '/auth') {
    return next();
  }
  const pin = req.headers['x-clinic-pin'];
  if (pin !== CLINIC_PIN) {
    return res.status(401).json({ error: 'Invalid or missing Clinic Password / PIN' });
  }
  next();
}

router.use(checkPin);

router.get(['/', '/health'], async (req, res) => {
  try {
    await ensureSchema();
    res.json({ status: 'ok', service: 'Clinic Text Records API', database: 'Turso Connected' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/auth', async (req, res) => {
  try {
    await ensureSchema();
    const { pin } = req.body || {};
    if (String(pin) === String(CLINIC_PIN)) {
      return res.json({ authenticated: true });
    }
    return res.status(401).json({ authenticated: false, error: 'Incorrect Clinic Password / PIN' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/dashboard', async (req, res) => {
  try {
    await ensureSchema();
    const [patientsCount, visitsToday, recentPatients] = await Promise.all([
      db.execute(`SELECT COUNT(*) AS total FROM patients`),
      db.execute(`SELECT COUNT(*) AS total FROM visits WHERE date(visit_date) = date('now')`),
      db.execute(`
        SELECT p.*,
          (SELECT COUNT(*) FROM visits v WHERE v.patient_id = p.id) AS visit_count,
          (SELECT MAX(visit_date) FROM visits v WHERE v.patient_id = p.id) AS last_visit
        FROM patients p
        ORDER BY p.updated_at DESC
        LIMIT 30
      `)
    ]);

    res.json({
      totalPatients: Number(patientsCount.rows[0]?.total || 0),
      visitsToday: Number(visitsToday.rows[0]?.total || 0),
      recentPatients: recentPatients.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/patients', async (req, res) => {
  try {
    await ensureSchema();
    const q = (req.query.q || '').trim();
    if (!q) {
      const all = await db.execute(`
        SELECT p.*,
          (SELECT COUNT(*) FROM visits v WHERE v.patient_id = p.id) AS visit_count,
          (SELECT MAX(visit_date) FROM visits v WHERE v.patient_id = p.id) AS last_visit
        FROM patients p
        ORDER BY p.updated_at DESC
        LIMIT 50
      `);
      return res.json(all.rows);
    }

    const like = `%${q}%`;
    const result = await db.execute({
      sql: `
        SELECT DISTINCT p.*,
          (SELECT COUNT(*) FROM visits v WHERE v.patient_id = p.id) AS visit_count,
          (SELECT MAX(visit_date) FROM visits v WHERE v.patient_id = p.id) AS last_visit
        FROM patients p
        LEFT JOIN visits v ON v.patient_id = p.id
        WHERE p.full_name LIKE ?
           OR p.phone LIKE ?
           OR p.file_number LIKE ?
           OR p.allergies LIKE ?
           OR v.diagnosis LIKE ?
           OR v.symptoms LIKE ?
           OR v.findings_tests_results LIKE ?
           OR v.medication_given LIKE ?
           OR v.doctor_lab_comments LIKE ?
        ORDER BY p.updated_at DESC
        LIMIT 50
      `,
      args: [like, like, like, like, like, like, like, like, like]
    });

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/patients', async (req, res) => {
  try {
    await ensureSchema();
    const {
      file_number,
      full_name,
      phone,
      age,
      sex,
      blood_group,
      allergies,
      chronic_conditions,
      next_of_kin,
      residence
    } = req.body;

    if (!full_name || !full_name.trim()) {
      return res.status(400).json({ error: 'Patient full name is required.' });
    }

    const generatedFileNo = (file_number && file_number.trim())
      ? file_number.trim().toUpperCase()
      : `PT-${Date.now().toString().slice(-6)}`;

    const insert = await db.execute({
      sql: `
        INSERT INTO patients (
          file_number, full_name, phone, age, sex, blood_group,
          allergies, chronic_conditions, next_of_kin, residence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        generatedFileNo,
        full_name.trim(),
        (phone || '').trim(),
        (age || '').trim(),
        (sex || '').trim(),
        (blood_group || '').trim(),
        (allergies || '').trim(),
        (chronic_conditions || '').trim(),
        (next_of_kin || '').trim(),
        (residence || '').trim()
      ]
    });

    const patientId = Number(insert.lastInsertRowid);
    const created = await db.execute({ sql: `SELECT * FROM patients WHERE id = ?`, args: [patientId] });
    res.status(201).json(created.rows[0]);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'That File Number already exists.' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.put('/patients/:id', async (req, res) => {
  try {
    await ensureSchema();
    const id = Number(req.params.id);
    const {
      file_number,
      full_name,
      phone,
      age,
      sex,
      blood_group,
      allergies,
      chronic_conditions,
      next_of_kin,
      residence
    } = req.body;

    await db.execute({
      sql: `
        UPDATE patients SET
          file_number = ?,
          full_name = ?,
          phone = ?,
          age = ?,
          sex = ?,
          blood_group = ?,
          allergies = ?,
          chronic_conditions = ?,
          next_of_kin = ?,
          residence = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `,
      args: [
        file_number, full_name, phone, age, sex, blood_group,
        allergies, chronic_conditions, next_of_kin, residence, id
      ]
    });

    const updated = await db.execute({ sql: `SELECT * FROM patients WHERE id = ?`, args: [id] });
    res.json(updated.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/patients/:id', async (req, res) => {
  try {
    await ensureSchema();
    const id = Number(req.params.id);

    const patientRes = await db.execute({ sql: `SELECT * FROM patients WHERE id = ?`, args: [id] });
    if (patientRes.rows.length === 0) {
      return res.status(404).json({ error: 'Patient file not found.' });
    }

    const visitsRes = await db.execute({
      sql: `SELECT * FROM visits WHERE patient_id = ? ORDER BY visit_date DESC, id DESC`,
      args: [id]
    });

    res.json({
      patient: patientRes.rows[0],
      visits: visitsRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/patients/:id/visits', async (req, res) => {
  try {
    await ensureSchema();
    const patientId = Number(req.params.id);
    const {
      vitals_bp,
      vitals_temp,
      vitals_pulse,
      vitals_weight,
      vitals_spo2,
      symptoms,
      findings_tests_results,
      diagnosis,
      medication_given,
      doctor_lab_comments,
      follow_up_note,
      amount_charged,
      amount_paid,
      payment_mode
    } = req.body;

    const visitInsert = await db.execute({
      sql: `
        INSERT INTO visits (
          patient_id, vitals_bp, vitals_temp, vitals_pulse, vitals_weight, vitals_spo2,
          symptoms, findings_tests_results, diagnosis, medication_given,
          doctor_lab_comments, follow_up_note, amount_charged, amount_paid, payment_mode
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        patientId,
        vitals_bp || '',
        vitals_temp || '',
        vitals_pulse || '',
        vitals_weight || '',
        vitals_spo2 || '',
        symptoms || '',
        findings_tests_results || '',
        diagnosis || '',
        medication_given || '',
        doctor_lab_comments || '',
        follow_up_note || '',
        Number(amount_charged || 0),
        Number(amount_paid || 0),
        payment_mode || 'Cash'
      ]
    });

    await db.execute({
      sql: `UPDATE patients SET updated_at = datetime('now') WHERE id = ?`,
      args: [patientId]
    });

    res.status(201).json({ success: true, visit_id: Number(visitInsert.lastInsertRowid) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/visits/:visitId', async (req, res) => {
  try {
    await ensureSchema();
    const visitId = Number(req.params.visitId);
    const {
      patient_id,
      vitals_bp,
      vitals_temp,
      vitals_pulse,
      vitals_weight,
      vitals_spo2,
      symptoms,
      findings_tests_results,
      diagnosis,
      medication_given,
      doctor_lab_comments,
      follow_up_note,
      amount_charged,
      amount_paid,
      payment_mode
    } = req.body;

    await db.execute({
      sql: `
        UPDATE visits SET
          vitals_bp = ?,
          vitals_temp = ?,
          vitals_pulse = ?,
          vitals_weight = ?,
          vitals_spo2 = ?,
          symptoms = ?,
          findings_tests_results = ?,
          diagnosis = ?,
          medication_given = ?,
          doctor_lab_comments = ?,
          follow_up_note = ?,
          amount_charged = ?,
          amount_paid = ?,
          payment_mode = ?
        WHERE id = ?
      `,
      args: [
        vitals_bp || '',
        vitals_temp || '',
        vitals_pulse || '',
        vitals_weight || '',
        vitals_spo2 || '',
        symptoms || '',
        findings_tests_results || '',
        diagnosis || '',
        medication_given || '',
        doctor_lab_comments || '',
        follow_up_note || '',
        Number(amount_charged || 0),
        Number(amount_paid || 0),
        payment_mode || 'Cash',
        visitId
      ]
    });

    if (patient_id) {
      await db.execute({
        sql: `UPDATE patients SET updated_at = datetime('now') WHERE id = ?`,
        args: [Number(patient_id)]
      });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use('/api', router);
app.use('/', router);

module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Clinic Text Records API running on http://localhost:${PORT}`));
}
