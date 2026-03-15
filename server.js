const express = require('express');
const mysql = require('mysql2');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const app = express();

app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));

// --- CONFIGURACIÓN BASE DE DATOS ---
const db = mysql.createPool({
    uri: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// --- FUNCIÓN GENÉRICA PARA ENVIAR CORREOS VÍA API BREVO ---
async function enviarEmailAPI(subject, html, toEmail, toName) {
    const data = {
        sender: { name: "CEN Rafael Arévalo González", email: process.env.EMAIL_USER },
        to: [{ email: toEmail, name: toName }],
        subject: subject,
        htmlContent: html
    };

    return axios.post('https://api.brevo.com/v3/smtp/email', data, {
        headers: {
            'api-key': process.env.EMAIL_PASS,
            'content-type': 'application/json'
        }
    });
}

let esperaRegistro = {};

// --- RUTAS DE REGISTRO ---

app.post('/solicitar-registro', async (req, res) => {
    const { nombre, apellido, cedula, email, password, rol, cedula_hijo } = req.body;
    const codigo = Math.floor(100000 + Math.random() * 900000);

    const html = `
        <div style="font-family: sans-serif; text-align: center; border: 1px solid #ddd; padding: 20px; border-radius: 15px;">
            <h2 style="color: #002D5A;">Código de Verificación</h2>
            <p>Tu código para registrarte en el sistema CEN es:</p>
            <h1 style="letter-spacing: 10px; color: #002D5A; background: #f4f4f4; display: inline-block; padding: 10px 20px;">${codigo}</h1>
        </div>`;

    try {
        await enviarEmailAPI("Código de Verificación - Registro", html, email, nombre);
        esperaRegistro[email] = { datos: { nombre, apellido, cedula, email, password, rol, cedula_hijo }, codigo: codigo };
        res.send({ mensaje: "Código enviado." });
    } catch (error) {
        res.status(500).send("Error al enviar el código.");
    }
});

app.post('/verificar-y-registrar', async (req, res) => {
    const { email, codigoRecibido } = req.body;
    const pendiente = esperaRegistro[email];
    if (!pendiente) return res.status(400).send("Sesión expirada.");

    if (pendiente.codigo == codigoRecibido) {
        const { nombre, apellido, cedula, password, rol, cedula_hijo } = pendiente.datos;
        try {
            const hash = await bcrypt.hash(password, 10);
            const sql = "INSERT INTO usuarios (nombre, apellido, cedula, email, password_hash, rol, cedula_representado, activo) VALUES (?, ?, ?, ?, ?, ?, ?, 1)";
            db.query(sql, [nombre, apellido, cedula, email, hash, rol, cedula_hijo], (err) => {
                if (err) return res.status(500).send("Error: Usuario duplicado.");
                delete esperaRegistro[email];
                res.send({ mensaje: "Registrado con éxito." });
            });
        } catch (e) { res.status(500).send("Error interno."); }
    } else { res.status(400).send("Código incorrecto."); }
});

// --- LOGIN ---
app.post('/login', (req, res) => {
    const { email, password } = req.body;
    const sql = "SELECT * FROM usuarios WHERE email = ? AND activo = 1";
    db.query(sql, [email], async (err, result) => {
        if (err || result.length === 0) return res.status(401).send("Usuario no existe.");
        const user = result[0];
        const match = await bcrypt.compare(password, user.password_hash);
        if (match) {
            res.send({ id_usuario: user.id_usuario, nombre_completo: `${user.nombre} ${user.apellido}`, rol: user.rol, cedula_hijo: user.cedula_representado });
        } else { res.status(401).send("Clave incorrecta."); }
    });
});

// --- GESTIÓN DE NOTAS CON ALERTA AUTOMÁTICA (REVISADO) ---
app.post('/guardar-nota', (req, res) => {
    const { estudiante, asignatura, nota, rol } = req.body;
    const sqlInsert = "INSERT INTO calificaciones (estudiante, asignatura, nota, rol_quien_registro) VALUES (?, ?, ?, ?)";

    db.query(sqlInsert, [estudiante, asignatura, nota, rol], (err, result) => {
        if (err) return res.status(500).send(err);

        // LÓGICA DE ALERTA: Si la nota es menor a 10
        if (parseFloat(nota) < 10) {
            console.log(`⚠️ Generando alerta para: ${estudiante}`);

            // Buscamos al representante vinculado por cédula
            const sqlBuscarRep = `
                SELECT r.email, r.nombre AS nombre_rep, s.nombre AS nombre_est 
                FROM usuarios s 
                JOIN usuarios r ON r.cedula_representado = s.cedula 
                WHERE CONCAT(s.nombre, ' ', s.apellido) = ? AND r.activo = 1`;

            db.query(sqlBuscarRep, [estudiante], async (errRep, results) => {
                if (!errRep && results.length > 0) {
                    const rep = results[0];

                    const htmlAlerta = `
                        <div style="font-family: sans-serif; border: 2px solid #ff0000; padding: 20px; border-radius: 15px;">
                            <h2 style="color: #d32f2f;">⚠️ Alerta Académica: Calificación Baja</h2>
                            <p>Estimado(a) <b>${rep.nombre_rep}</b>,</p>
                            <p>Le informamos que el estudiante <b>${rep.nombre_est}</b> ha obtenido una nota de 
                            <span style="color: #d32f2f; font-size: 20px; font-weight: bold;">${nota}</span> 
                            en la asignatura <b>${asignatura}</b>.</p>
                            <p>Se recomienda contactar con el docente a la brevedad posible a través del módulo de mensajería de la plataforma.</p>
                            <hr>
                            <p style="font-size: 10px; color: #777;">CEN Rafael Arévalo González - Notificación Automática</p>
                        </div>`;

                    try {
                        await enviarEmailAPI(`⚠️ ALERTA ACADÉMICA: ${rep.nombre_est}`, htmlAlerta, rep.email, rep.nombre_rep);
                        console.log("🚀 Alerta enviada al representante");
                    } catch (e) { console.error("Error al enviar alerta email"); }
                }
            });
        }
        res.send({ mensaje: "Nota guardada." });
    });
});

app.get('/mis-notas/:nombre', (req, res) => {
    db.query("SELECT asignatura, nota, fecha_registro FROM calificaciones WHERE estudiante = ? ORDER BY fecha_registro DESC", [req.params.nombre], (err, results) => {
        if (err) return res.status(500).send(err);
        res.send(results);
    });
});

app.get('/estudiantes-lista', (req, res) => {
    db.query("SELECT nombre, apellido FROM usuarios WHERE rol = 'Estudiante' AND activo = 1", (err, results) => {
        if (err) return res.status(500).send(err);
        res.send(results);
    });
});

// --- MENSAJERÍA ---
app.get('/usuarios', (req, res) => {
    db.query("SELECT id_usuario, nombre, apellido, rol FROM usuarios WHERE activo = 1", (err, results) => {
        if (err) return res.status(500).send(err);
        res.send(results);
    });
});

app.post('/enviar-mensaje', (req, res) => {
    const { remitente_id, destinatario_id, asunto, contenido } = req.body;
    db.query("INSERT INTO mensajes (remitente_id, destinatario_id, asunto, contenido) VALUES (?, ?, ?, ?)", [remitente_id, destinatario_id, asunto, contenido], (err) => {
        if (err) return res.status(500).send(err);
        res.send({ mensaje: "Mensaje enviado." });
    });
});

app.get('/mensajes/:userId', (req, res) => {
    const sql = `SELECT m.*, CONCAT(u.nombre, ' ', u.apellido) AS nombre_remitente FROM mensajes m JOIN usuarios u ON m.remitente_id = u.id_usuario WHERE m.destinatario_id = ? ORDER BY m.fecha_envio DESC`;
    db.query(sql, [req.params.userId], (err, results) => {
        if (err) return res.status(500).send(err);
        res.send(results);
    });
});

// --- PERFIL ---
app.get('/perfil/:id', (req, res) => {
    db.query("SELECT nombre, apellido, cedula, email, rol, cedula_representado FROM usuarios WHERE id_usuario = ?", [req.params.id], (err, result) => {
        if (err || result.length === 0) return res.status(404).send("No encontrado");
        res.json(result[0]);
    });
});

app.get('/nombre-hijo/:cedula', (req, res) => {
    db.query("SELECT nombre, apellido FROM usuarios WHERE cedula = ?", [req.params.cedula], (err, result) => {
        if (err || result.length === 0) return res.status(404).send("No encontrado");
        res.send({ nombre_completo: `${result[0].nombre} ${result[0].apellido}` });
    });
});

app.get('/stats-docente', (req, res) => {
    const q = `SELECT (SELECT COUNT(*) FROM usuarios WHERE rol='Estudiante' AND activo=1) as estudiantes, (SELECT COUNT(*) FROM calificaciones WHERE nota < 10) as alertas, (SELECT COUNT(*) FROM calificaciones) as evaluaciones`;
    db.query(q, (err, result) => {
        if (err) return res.status(500).send(err);
        res.json(result[0]);
    });
});

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'login.html')); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));