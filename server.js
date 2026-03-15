const express = require('express');
const mysql = require('mysql2');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');
const app = express();

app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));

const DB_URL = process.env.DATABASE_URL;

const db = mysql.createPool({
    uri: DB_URL,
    ssl: { rejectUnauthorized: false },
    waitForConnections: true,
    connectionLimit: 10
});

const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true, // true para puerto 465 (SSL)
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

let esperaRegistro = {};

// --- REGISTRO Y LOGIN ---

app.get('/estudiantes-lista', (req, res) => {
    db.query("SELECT nombre, apellido, CONCAT(nombre, ' ', apellido) as nombre_completo FROM usuarios WHERE rol = 'Estudiante' AND activo = 1", (err, results) => {
        if (err) return res.status(500).send(err);
        res.send(results);
    });
});

app.post('/solicitar-registro', async (req, res) => {
    const { nombre, apellido, cedula, email, password, rol, cedula_hijo } = req.body;
    const codigo = Math.floor(100000 + Math.random() * 900000);
    const mailOptions = {
        from: '"CEN Rafael Arévalo González" <p11484295@gmail.com>',
        to: email,
        subject: 'Código de Verificación - Registro',
        html: `<h2>Hola, ${nombre}</h2><p>Tu código es: <b>${codigo}</b></p>`
    };
    transporter.sendMail(mailOptions, (err) => {
        if (err) return res.status(500).send("Error al enviar el correo.");
        esperaRegistro[email] = { datos: { nombre, apellido, cedula, email, password, rol, cedula_hijo }, codigo: codigo };
        res.send({ mensaje: "Código enviado." });
    });
});

app.post('/verificar-y-registrar', async (req, res) => {
    const { email, codigoRecibido } = req.body;
    const pendiente = esperaRegistro[email];
    if (!pendiente) return res.status(400).send("No hay registros pendientes.");
    if (pendiente.codigo == codigoRecibido) {
        const { nombre, apellido, cedula, password, rol, cedula_hijo } = pendiente.datos;
        try {
            const hash = await bcrypt.hash(password, 10);
            const sql = "INSERT INTO usuarios (nombre, apellido, cedula, email, password_hash, rol, cedula_representado, activo) VALUES (?, ?, ?, ?, ?, ?, ?, 1)";
            db.query(sql, [nombre, apellido, cedula, email, hash, rol, cedula_hijo], (err) => {
                if (err) return res.status(500).send("Error: Cédula o correo ya existen.");
                delete esperaRegistro[email];
                res.send({ mensaje: "Usuario creado con éxito." });
            });
        } catch (e) { res.status(500).send("Error interno."); }
    } else { res.status(400).send("Código incorrecto."); }
});

app.post('/login', (req, res) => {
    const { email, password } = req.body;
    const sql = "SELECT * FROM usuarios WHERE email = ? AND activo = 1";
    db.query(sql, [email], async (err, result) => {
        if (err || result.length === 0) return res.status(401).send("Usuario no existe o está inhabilitado");
        const user = result[0];
        const match = await bcrypt.compare(password, user.password_hash);
        if (match) {
            res.send({ id_usuario: user.id_usuario, nombre_completo: `${user.nombre} ${user.apellido}`, rol: user.rol, cedula_hijo: user.cedula_representado });
        } else { res.status(401).send("Clave incorrecta"); }
    });
});

// --- GESTIÓN DE NOTAS ---

app.post('/guardar-nota', (req, res) => {
    const { estudiante, asignatura, nota, rol } = req.body;
    const sqlInsert = "INSERT INTO calificaciones (estudiante, asignatura, nota, rol_quien_registro) VALUES (?, ?, ?, ?)";
    db.query(sqlInsert, [estudiante, asignatura, nota, rol], (err, result) => {
        if (err) return res.status(500).send(err);
        if (parseFloat(nota) < 10) {
            const sqlBuscarRep = `SELECT r.email, r.nombre AS nombre_rep, s.nombre AS nombre_est FROM usuarios s JOIN usuarios r ON r.cedula_representado = s.cedula WHERE CONCAT(s.nombre, ' ', s.apellido) = ? AND r.activo = 1`;
            db.query(sqlBuscarRep, [estudiante], (errRep, results) => {
                if (!errRep && results.length > 0) {
                    const rep = results[0];
                    const mailOptions = {
                        from: '"CEN RAG Alertas" <p11484295@gmail.com>',
                        to: rep.email,
                        subject: `⚠️ ALERTA ACADÉMICA: ${rep.nombre_est}`,
                        html: `
                            <div style="font-family: sans-serif; border: 2px solid #ff0000; padding: 20px; border-radius: 15px;">
                                <h2 style="color: #d32f2f;">Notificación de Calificación Baja</h2>
                                <p>Estimado(a) <b>${rep.nombre_rep}</b>,</p>
                                <p>Le informamos que el estudiante <b>${rep.nombre_est}</b> ha obtenido una nota de 
                                <span style="color: #d32f2f; font-size: 18px; font-weight: bold;">${nota}</span> 
                                en la asignatura <b>${asignatura}</b>.</p>
                                <p>Por favor, asista a la institución para conversar con el docente.</p>
                                <hr>
                                <p style="font-size: 10px; color: #777;">CEN Rafael Arévalo González - Mensaje Automático</p>
                            </div>`
                    };
                    transporter.sendMail(mailOptions);
                }
            });
        }
        res.send({ mensaje: "Nota guardada" });
    });
});

app.get('/mis-notas/:nombre', (req, res) => {
    db.query("SELECT asignatura, nota, fecha_registro FROM calificaciones WHERE estudiante = ? ORDER BY fecha_registro DESC", [req.params.nombre], (err, results) => {
        if (err) return res.status(500).send(err);
        res.send(results);
    });
});

// --- MENSAJERÍA ---

app.get('/usuarios', (req, res) => {
    db.query("SELECT id_usuario, nombre, apellido, CONCAT(nombre, ' ', apellido) as nombre_completo, rol FROM usuarios WHERE activo = 1", (err, results) => {
        if (err) return res.status(500).send(err);
        res.send(results);
    });
});

app.post('/enviar-mensaje', (req, res) => {
    const { remitente_id, destinatario_id, asunto, contenido } = req.body;
    db.query("INSERT INTO mensajes (remitente_id, destinatario_id, asunto, contenido) VALUES (?, ?, ?, ?)", [remitente_id, destinatario_id, asunto, contenido], (err) => {
        if (err) return res.status(500).send(err);
        res.send({ mensaje: "Enviado con éxito" });
    });
});

app.get('/mensajes/:userId', (req, res) => {
    const sql = `SELECT m.*, CONCAT(u.nombre, ' ', u.apellido) AS nombre_remitente FROM mensajes m JOIN usuarios u ON m.remitente_id = u.id_usuario WHERE m.destinatario_id = ? ORDER BY m.fecha_envio DESC`;
    db.query(sql, [req.params.userId], (err, results) => {
        if (err) return res.status(500).send(err);
        res.send(results);
    });
});

// --- RUTAS ADMINISTRATIVAS ---

app.get('/admin/usuarios', (req, res) => {
    db.query("SELECT id_usuario, nombre, apellido, cedula, email, rol FROM usuarios WHERE activo = 1", (err, results) => {
        if (err) return res.status(500).send(err);
        res.send(results);
    });
});

app.get('/admin/usuarios-inactivos', (req, res) => {
    db.query("SELECT id_usuario, nombre, apellido, cedula, email, rol, fecha_inhabilitado, inhabilitado_por FROM usuarios WHERE activo = 0", (err, results) => {
        if (err) return res.status(500).send(err);
        res.send(results);
    });
});

app.put('/admin/usuarios/:id/rol', (req, res) => {
    db.query("UPDATE usuarios SET rol = ? WHERE id_usuario = ?", [req.body.nuevoRol, req.params.id], (err) => {
        if (err) return res.status(500).send(err);
        res.send({ mensaje: "Rol actualizado" });
    });
});

app.put('/admin/usuarios/:id/estado', (req, res) => {
    const { activo, admin_nombre } = req.body;
    const sql = activo === 0
        ? "UPDATE usuarios SET activo = 0, fecha_inhabilitado = NOW(), inhabilitado_por = ? WHERE id_usuario = ?"
        : "UPDATE usuarios SET activo = 1, fecha_inhabilitado = NULL, inhabilitado_por = NULL WHERE id_usuario = ?";
    const params = activo === 0 ? [admin_nombre, req.params.id] : [req.params.id];
    db.query(sql, params, (err) => {
        if (err) return res.status(500).send(err);
        res.send({ mensaje: "Estado actualizado" });
    });
});

// --- GESTIÓN DE NOTAS PARA ADMINISTRADOR ---

app.get('/admin/notas', (req, res) => {
    db.query("SELECT * FROM calificaciones ORDER BY fecha_registro DESC", (err, results) => {
        if (err) return res.status(500).send(err);
        res.send(results);
    });
});

app.put('/admin/notas/:id', (req, res) => {
    const { nota } = req.body;
    db.query("UPDATE calificaciones SET nota = ? WHERE id_nota = ?", [nota, req.params.id], (err) => {
        if (err) return res.status(500).send(err);
        res.send({ mensaje: "Nota actualizada" });
    });
});

app.delete('/admin/notas/:id', (req, res) => {
    db.query("DELETE FROM calificaciones WHERE id_nota = ?", [req.params.id], (err) => {
        if (err) return res.status(500).send(err);
        res.send({ mensaje: "Nota eliminada" });
    });
});

app.get('/stats-docente', (req, res) => {
    const q = `SELECT (SELECT COUNT(*) FROM usuarios WHERE rol='Estudiante' AND activo=1) as estudiantes, (SELECT COUNT(*) FROM calificaciones WHERE nota < 10) as alertas, (SELECT COUNT(*) FROM calificaciones) as evaluaciones`;
    db.query(q, (err, result) => {
        if (err) return res.status(500).send(err);
        res.json(result[0]);
    });
});

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

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'login.html')); });
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor CEN funcionando en puerto ${PORT}`));