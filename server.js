require('dotenv').config({ path: '.env.local' });
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');
const fs = require('fs');
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');

const app = express();
const upload = multer({ 
    dest: 'uploads/',
    fileFilter: (req, file, cb) => {
        // Erlaubte MIME-Types für Bilder und PDFs
        const allowedTypes = [
            'image/jpeg',
            'image/png',
            'image/heic',
            'image/heif',
            'image/webp',
            'application/pdf'
        ];
        
        console.log('Received file:', file.originalname, 'Type:', file.mimetype);
        
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Nicht unterstütztes Dateiformat. Erlaubt sind: JPG, PNG, HEIC, HEIF, WEBP und PDF'));
        }
    }
});

// Serve static files
app.use(express.static(path.join(__dirname)));

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Convert image to PDF
async function convertImageToPdf(imagePath, originalName) {
    console.log('Starting image conversion for:', originalName);
    try {
        const pdfDoc = await PDFDocument.create();
        const page = pdfDoc.addPage([595, 842]); // A4 size
        
        console.log('Converting image to PNG format...');
        // Konvertiere zuerst in PNG mit weißem Hintergrund
        const pngBuffer = await sharp(imagePath)
            .flatten({ background: { r: 255, g: 255, b: 255, alpha: 1 } })
            .resize(595, 842, { 
                fit: 'contain',
                background: { r: 255, g: 255, b: 255, alpha: 1 }
            })
            .png()
            .toBuffer();

        console.log('Embedding PNG into PDF...');
        const image = await pdfDoc.embedPng(pngBuffer);
        
        const { width, height } = image.scale(1);
        const maxWidth = page.getWidth();
        const maxHeight = page.getHeight();
        const scale = Math.min(maxWidth / width, maxHeight / height);
        
        page.drawImage(image, {
            x: (maxWidth - width * scale) / 2,
            y: (maxHeight - height * scale) / 2,
            width: width * scale,
            height: height * scale
        });

        console.log('Saving PDF...');
        return await pdfDoc.save();
    } catch (error) {
        console.error('PDF conversion error:', error);
        throw new Error(`Fehler bei der PDF-Konvertierung: ${error.message}`);
    }
}

// Handle file uploads
app.post('/api/upload', upload.single('document'), async (req, res) => {
    console.log('Upload request received');
    
    if (!req.file) {
        console.error('No file in request');
        return res.status(400).json({ error: 'Keine Datei hochgeladen' });
    }

    console.log('File details:', {
        filename: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size
    });

    let pdfPath = null;

    try {
        const paperlessUrl = process.env.REACT_APP_PAPERLESS_URL || process.env.PAPERLESS_URL;
        const paperlessToken = process.env.REACT_APP_PAPERLESS_TOKEN || process.env.PAPERLESS_TOKEN;

        if (!paperlessUrl || !paperlessToken) {
            throw new Error('Paperless-Konfiguration fehlt');
        }

        console.log('Paperless URL:', paperlessUrl);

        // Konvertiere zu PDF wenn es ein Bild ist
        const isImage = req.file.mimetype.startsWith('image/');
        if (isImage) {
            console.log('Converting image to PDF...');
            const pdfBuffer = await convertImageToPdf(req.file.path, req.file.originalname);
            pdfPath = req.file.path + '.pdf';
            await fs.promises.writeFile(pdfPath, pdfBuffer);
            console.log('PDF conversion complete:', pdfPath);
        }

        // Forward to Paperless-ngx
        try {
            // Entferne trailing slashes und baue die URL korrekt auf
            const baseUrl = paperlessUrl.replace(/\/+$/, '');
            const uploadUrl = `${baseUrl}/api/documents/post_document/`;
            
            console.log('Attempting upload to:', uploadUrl);

            // Create form data for Paperless-ngx
            const formData = new FormData();
            const filePath = isImage ? pdfPath : req.file.path;
            const fileName = isImage ? req.file.originalname.replace(/\.[^/.]+$/, '.pdf') : req.file.originalname;

            // Überprüfe die Datei vor dem Upload
            if (!fs.existsSync(filePath)) {
                throw new Error(`Datei ${filePath} existiert nicht`);
            }

            const fileStats = fs.statSync(filePath);
            console.log('File stats before upload:', {
                size: fileStats.size,
                path: filePath
            });

            const fileStream = fs.createReadStream(filePath);
            // Benutze den gleichen Schlüssel wie in der React-App
            formData.append('document', fileStream, fileName);

            // Log request details
            console.log('Request details:', {
                url: uploadUrl,
                fileName: fileName,
                fileSize: fileStats.size,
                headers: {
                    ...formData.getHeaders(),
                    'Authorization': `Token ${paperlessToken}`,
                    'Accept': 'application/json'
                }
            });
            
            const response = await axios.post(uploadUrl, formData, {
                headers: {
                    ...formData.getHeaders(),
                    'Authorization': `Token ${paperlessToken}`,
                    'Accept': 'application/json'
                },
                maxBodyLength: Infinity,
                maxContentLength: Infinity,
                timeout: 60000 // 60 Sekunden Timeout
            });

            // Log the complete response for debugging
            console.log('Response details:', {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
                data: response.data
            });

            console.log('Upload successful, response:', response.data);
            res.json({ success: true, paperlessResponse: response.data });
        } catch (uploadError) {
            console.error('Paperless upload error details:', {
                message: uploadError.message,
                code: uploadError.code,
                response: {
                    data: uploadError.response?.data,
                    status: uploadError.response?.status,
                    statusText: uploadError.response?.statusText,
                    headers: uploadError.response?.headers
                },
                request: {
                    url: uploadError.config?.url,
                    method: uploadError.config?.method,
                    headers: uploadError.config?.headers
                }
            });
            
            let errorMessage = 'Upload fehlgeschlagen';
            if (uploadError.response?.data?.detail) {
                errorMessage += `: ${uploadError.response.data.detail}`;
            } else if (uploadError.response?.status === 401) {
                errorMessage += ': Authentifizierung fehlgeschlagen (Bitte Token überprüfen)';
            } else if (uploadError.response?.status === 403) {
                errorMessage += ': Keine Berechtigung (Bitte Berechtigungen überprüfen)';
            } else if (uploadError.response?.status === 404) {
                errorMessage += ': API-Endpunkt nicht gefunden (Bitte URL überprüfen)';
            } else if (uploadError.code === 'ECONNREFUSED') {
                errorMessage += ': Verbindung zu Paperless nicht möglich (Server nicht erreichbar)';
            } else if (uploadError.code === 'ETIMEDOUT') {
                errorMessage += ': Zeitüberschreitung bei der Verbindung';
            } else if (uploadError.message) {
                errorMessage += `: ${uploadError.message}`;
            }
            
            throw new Error(errorMessage);
        }
    } catch (error) {
        console.error('Error details:', {
            message: error.message,
            code: error.code,
            stack: error.stack
        });
        
        res.status(500).json({ 
            error: 'Fehler beim Verarbeiten oder Hochladen des Dokuments',
            details: error.message,
            serverError: error.response?.data || error.code
        });
    } finally {
        // Clean up temporary files
        try {
            if (req.file && fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
                console.log('Cleaned up original file');
            }
            if (pdfPath && fs.existsSync(pdfPath)) {
                fs.unlinkSync(pdfPath);
                console.log('Cleaned up PDF file');
            }
        } catch (cleanupError) {
            console.error('Cleanup error:', cleanupError);
        }
    }
});

const PORT = process.env.PORT || 3005;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('Environment:', {
        paperlessUrl: process.env.REACT_APP_PAPERLESS_URL || process.env.PAPERLESS_URL,
        hasToken: !!(process.env.REACT_APP_PAPERLESS_TOKEN || process.env.PAPERLESS_TOKEN)
    });
}); 