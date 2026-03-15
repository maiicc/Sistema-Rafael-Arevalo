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
    connectionLimit: 10
});

// --- FUNCIÓN PARA ENVIAR CORREOS USANDO GOOGLE APPS SCRIPT ---
async function enviarEmailAPI(subject, html, toEmail) {
    const data = {
        to: toEmail,
        subject: subject,
        html: html
    };

    // Usamos la URL que te dio Google al publicar tu Script
    return axios.post(process.env.GOOGLE_SCRIPT_URL, data);
}

let esperaRegistro = {};

// --- RUTAS DE REGISTRO ---

app.post('/solicitar-registro', async (req, res) => {
    const { nombre, email } = req.body;
    const codigo = Math.floor(100000 + Math.random() * 900000);

    const html = `
        <div style="font-family: sans-serif; text-align: center; border: 1px solid #ddd; padding: 20px; border-radius: 15px;">
            <h2 style="color: #002D5A;">Código de Verificación</h2>
            <p>Hola <b>${nombre}</b>, tu código para registrarte en el sistema es:</p>
            <h1 style="letter-spacing: 10px; color: #002D5A; background: #f4f4f4; display: inline-block; padding: 10px 20px; border-radius: 10px;">${codigo}</h1>
        </div>`;

    try {
        await enviarEmailAPI("Código de Verificación - Registro", html, email);
        esperaRegistro[email] = { datos: req.body, codigo: codigo };
        console.log(`✅ Correo enviado vía Google a ${email}`);
        res.send({ mensaje: "Código enviado." });
    } catch (error) {
        console.error("❌ Error en Google Script:", error.message);
        res.status(500).send("Error al enviar el correo de verificación.");
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

// --- GESTIÓN DE NOTAS CON ALERTA ---
app.post('/guardar-nota', (req, res) => {
    const { estudiante, asignatura, nota, rol } = req.body;
    const sqlInsert = "INSERT INTO calificaciones (estudiante, asignatura, nota, rol_quien_registro) VALUES (?, ?, ?, ?)";

    db.query(sqlInsert, [estudiante, asignatura, nota, rol], (err) => {
        if (err) return res.status(500).send(err);

        if (parseFloat(nota) < 10) {
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
                                <h2 style="color: #d32f2f;">Notificación de Calificación Baja</h2>
                                <p>Estimado(a) <b>${rep.nombre_rep}</b>,</p>
                                <p>Le informamos que el estudiante <b>${rep.nombre_est}</b> ha obtenido una nota de 
                                <span style="color: #d32f2f; font-size: 18px; font-weight: bold;">${nota}</span> 
                                en la asignatura <b>${asignatura}</b>.</p>
                                <p>Por favor, asista a la institución para conversar con el docente.</p>
                                <hr>
                                <p style="font-size: 10px; color: #777;">CEN Rafael Arévalo González - Mensaje Automático</p>
                            </div>`;

                    try {
                        await enviarEmailAPI(`⚠️ ALERTA DE CALIFICACIÓN`, htmlAlerta, rep.email);
                    } catch (e) { console.error("❌ Error enviando alerta"); }
                }
            });
        }
        res.send({ mensaje: "Nota guardada." });
    });
});

// --- OTRAS RUTAS ---
app.get('/mis-notas/:nombre', (req, res) => {
    db.query("SELECT asignatura, nota, fecha_registro FROM calificaciones WHERE estudiante = ? ORDER BY fecha_registro DESC", [req.params.nombre], (err, results) => {
        if (err) return res.status(500).send(err);
        res.send(results);
    });
});

app.get('/estudiantes-lista', (req, res) => {
    db.query("SELECT nombre, apellido, CONCAT(nombre, ' ', apellido) as nombre_completo FROM usuarios WHERE rol = 'Estudiante' AND activo = 1", (err, r) => res.send(r));
});

app.get('/usuarios', (req, res) => {
    db.query("SELECT id_usuario, nombre, apellido, CONCAT(nombre, ' ', apellido) as nombre_completo, rol FROM usuarios WHERE activo = 1", (err, r) => res.send(r));
});

app.post('/enviar-mensaje', (req, res) => {
    const { remitente_id, destinatario_id, asunto, contenido } = req.body;
    db.query("INSERT INTO mensajes (remitente_id, destinatario_id, asunto, contenido) VALUES (?, ?, ?, ?)", [remitente_id, destinatario_id, asunto, contenido], (err) => res.send({ mensaje: "OK" }));
});

app.get('/mensajes/:userId', (req, res) => {
    const sql = `SELECT m.*, CONCAT(u.nombre, ' ', u.apellido) AS nombre_remitente FROM mensajes m JOIN usuarios u ON m.remitente_id = u.id_usuario WHERE m.destinatario_id = ? ORDER BY m.fecha_envio DESC`;
    db.query(sql, [req.params.userId], (err, r) => res.send(r));
});

app.get('/stats-docente', (req, res) => {
    const q = `SELECT (SELECT COUNT(*) FROM usuarios WHERE rol='Estudiante' AND activo=1) as estudiantes, (SELECT COUNT(*) FROM calificaciones WHERE nota < 10) as alertas, (SELECT COUNT(*) FROM calificaciones) as evaluaciones`;
    db.query(q, (err, r) => res.json(r[0]));
});

app.get('/perfil/:id', (req, res) => {
    db.query("SELECT nombre, apellido, cedula, email, rol, cedula_representado FROM usuarios WHERE id_usuario = ?", [req.params.id], (err, r) => res.json(r[0]));
});

app.get('/nombre-hijo/:cedula', (req, res) => {
    db.query("SELECT nombre, apellido FROM usuarios WHERE cedula = ?", [req.params.cedula], (err, r) => {
        if (r.length > 0) res.send({ nombre_completo: `${r[0].nombre} ${r[0].apellido}` });
        else res.status(404).send("No encontrado");
    });
});

app.get('/admin/usuarios', (req, res) => { db.query("SELECT * FROM usuarios WHERE activo=1", (err, r) => res.send(r)); });
app.get('/admin/usuarios-inactivos', (req, res) => { db.query("SELECT * FROM usuarios WHERE activo=0", (err, r) => res.send(r)); });
app.put('/admin/usuarios/:id/rol', (req, res) => { db.query("UPDATE usuarios SET rol=? WHERE id_usuario=?", [req.body.nuevoRol, req.params.id], (err) => res.send({ mensaje: "OK" })); });
app.put('/admin/usuarios/:id/estado', (req, res) => {
    const { activo, admin_nombre } = req.body;
    const sql = activo === 0 ? "UPDATE usuarios SET activo=0, fecha_inhabilitado=NOW(), inhabilitado_por=? WHERE id_usuario=?" : "UPDATE usuarios SET activo=1, fecha_inhabilitado=NULL, inhabilitado_por=NULL WHERE id_usuario=?";
    db.query(sql, [admin_nombre || 'Admin', req.params.id], (err) => res.send({ mensaje: "OK" }));
});

app.get('/admin/notas', (req, res) => { db.query("SELECT * FROM calificaciones ORDER BY fecha_registro DESC", (err, r) => res.send(r)); });
app.put('/admin/notas/:id', (req, res) => { db.query("UPDATE calificaciones SET nota=? WHERE id_nota=?", [req.body.nota, req.params.id], (err) => res.send({ mensaje: "OK" })); });
app.delete('/admin/notas/:id', (req, res) => { db.query("DELETE FROM calificaciones WHERE id_nota=?", [req.params.id], (err) => res.send({ mensaje: "OK" })); });

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'login.html')); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor funcionando en puerto ${PORT}`));