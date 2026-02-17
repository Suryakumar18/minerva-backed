const express = require('express');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const multer = require('multer');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const fs = require('fs-extra');
const path = require('path');

const app = express();

// Trust proxy - required for rate limiting behind a proxy (like Render)
app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// CORS configuration
app.use(cors({
    origin: ['https://minevera-school-frontend.vercel.app', 'http://localhost:5173', 'http://localhost:5174'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Rate limiting to prevent spam
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 50,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        return req.ip || req.connection.remoteAddress;
    },
    skip: (req) => {
        return req.path === '/health' || req.path === '/test-email';
    }
});

app.use('/api/admission', limiter);
app.use('/api/contact', limiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan('dev'));

// Ensure temp directory exists
const tempDir = path.join(__dirname, 'temp');
fs.ensureDirSync(tempDir);

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 5 * 1024 * 1024,
    },
    fileFilter: (req, file, cb) => {
        if (file.fieldname === 'photo') {
            if (!file.originalname.match(/\.(jpg|jpeg|png|gif)$/i)) {
                return cb(new Error('Only image files are allowed!'), false);
            }
        }
        cb(null, true);
    }
});

// =============================================
// EMAIL CONFIGURATION WITH MULTIPLE FALLBACKS
// =============================================

// Try different SMTP configurations
const emailConfigs = [
    // Config 1: Gmail with 587 (TLS)
    {
        name: 'Gmail 587',
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        auth: {
            user: 'roobankr6@gmail.com',
            pass: 'jvjkdwuhtmgvlldf'
        },
        tls: {
            rejectUnauthorized: false,
            ciphers: 'SSLv3'
        }
    },
    // Config 2: Gmail with 465 (SSL)
    {
        name: 'Gmail 465',
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: {
            user: 'roobankr6@gmail.com',
            pass: 'jvjkdwuhtmgvlldf'
        },
        tls: {
            rejectUnauthorized: false
        }
    },
    // Config 3: Gmail with 25 (if allowed)
    {
        name: 'Gmail 25',
        host: 'smtp.gmail.com',
        port: 25,
        secure: false,
        auth: {
            user: 'roobankr6@gmail.com',
            pass: 'jvjkdwuhtmgvlldf'
        },
        tls: {
            rejectUnauthorized: false
        }
    }
];

let transporter = null;
let activeConfig = null;

// Function to create transporter with timeout
const createTransporter = (config) => {
    return nodemailer.createTransport({
        ...config,
        connectionTimeout: 30000, // 30 seconds
        greetingTimeout: 30000,
        socketTimeout: 30000,
        debug: true,
        logger: true,
        pool: false // Disable pooling for testing
    });
};

// Try to connect with each configuration
const findWorkingConfig = async () => {
    console.log('🔍 Testing email configurations...');
    
    for (const config of emailConfigs) {
        try {
            console.log(`Testing ${config.name}...`);
            const testTransporter = createTransporter(config);
            
            // Test with a shorter timeout
            const verifyPromise = testTransporter.verify();
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Verification timeout')), 10000);
            });
            
            await Promise.race([verifyPromise, timeoutPromise]);
            
            console.log(`✅ ${config.name} works!`);
            return { transporter: testTransporter, config };
        } catch (error) {
            console.log(`❌ ${config.name} failed:`, error.message);
        }
    }
    
    return { transporter: null, config: null };
};

// Initialize email on startup
(async () => {
    const result = await findWorkingConfig();
    if (result.transporter) {
        transporter = result.transporter;
        activeConfig = result.config;
        console.log(`✅ Using email config: ${activeConfig.name}`);
    } else {
        console.log('❌ No working email configuration found');
        console.log('⚠️ Will fall back to file storage mode');
    }
})();

// Helper function to save form data to file (fallback when email fails)
const saveFormToFile = async (formData, pdfBuffer, photoFile) => {
    const timestamp = Date.now();
    const sanitizedName = formData.childName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const formDir = path.join(__dirname, 'temp', `admission_${sanitizedName}_${timestamp}`);
    
    await fs.ensureDir(formDir);
    
    // Save PDF
    const pdfPath = path.join(formDir, 'form.pdf');
    await fs.writeFile(pdfPath, pdfBuffer);
    
    // Save photo if exists
    if (photoFile && photoFile.buffer) {
        const photoPath = path.join(formDir, `photo${path.extname(photoFile.originalname) || '.jpg'}`);
        await fs.writeFile(photoPath, photoFile.buffer);
    }
    
    // Save form data as JSON
    const dataPath = path.join(formDir, 'data.json');
    await fs.writeJSON(dataPath, formData, { spaces: 2 });
    
    console.log(`✅ Form saved to: ${formDir}`);
    return formDir;
};

// Helper function to create styled tables in PDF
const createStyledTable = (doc, headers, data, startY, columnWidths) => {
    try {
        const tableTop = startY;
        const rowHeight = 25;
        const cellPadding = 5;
        
        const headerBgColor = '#4F46E5';
        const headerTextColor = '#FFFFFF';
        const alternateRowColor = '#F3F4F6';
        const borderColor = '#E5E7EB';
        
        doc.fillColor(headerBgColor);
        doc.rect(50, tableTop, 500, rowHeight).fill();
        
        doc.fillColor(headerTextColor);
        doc.font('Helvetica-Bold').fontSize(10);
        
        let xPosition = 50;
        headers.forEach((header, i) => {
            doc.text(header, xPosition + cellPadding, tableTop + 8, {
                width: columnWidths[i] - (cellPadding * 2),
                align: 'left'
            });
            xPosition += columnWidths[i];
        });
        
        let yPosition = tableTop + rowHeight;
        
        data.forEach((row, rowIndex) => {
            if (rowIndex % 2 === 0) {
                doc.fillColor(alternateRowColor);
                doc.rect(50, yPosition, 500, rowHeight).fill();
            }
            
            doc.strokeColor(borderColor).lineWidth(0.5);
            
            let lineX = 50;
            for (let i = 0; i <= columnWidths.length; i++) {
                doc.moveTo(lineX, yPosition)
                   .lineTo(lineX, yPosition + rowHeight)
                   .stroke();
                if (i < columnWidths.length) lineX += columnWidths[i];
            }
            
            doc.moveTo(50, yPosition)
               .lineTo(550, yPosition)
               .stroke();
            
            doc.fillColor('#1F2937').font('Helvetica').fontSize(9);
            
            xPosition = 50;
            row.forEach((cell, cellIndex) => {
                const cellText = cell?.toString() || 'N/A';
                doc.text(cellText, xPosition + cellPadding, yPosition + 6, {
                    width: columnWidths[cellIndex] - (cellPadding * 2),
                    align: 'left'
                });
                xPosition += columnWidths[cellIndex];
            });
            
            yPosition += rowHeight;
        });
        
        doc.moveTo(50, yPosition)
           .lineTo(550, yPosition)
           .stroke();
        
        doc.fillColor('black');
        
        return yPosition;
    } catch (error) {
        console.error('Error in createStyledTable:', error);
        return startY + 50;
    }
};

// Helper function to generate PDF
const generatePDF = async (formData, photoBuffer) => {
    return new Promise((resolve, reject) => {
        try {
            console.log('Starting PDF generation...');
            
            const doc = new PDFDocument({
                size: 'A4',
                margin: 50,
                autoFirstPage: true,
                bufferPages: true,
                info: {
                    Title: `Admission Form - ${formData.childName || 'Unknown'}`,
                    Author: 'Minervaa Vidhya Mandhir School'
                }
            });
            
            const chunks = [];
            
            doc.on('data', chunk => chunks.push(chunk));
            doc.on('end', () => {
                const finalBuffer = Buffer.concat(chunks);
                console.log(`✅ PDF generated: ${finalBuffer.length} bytes`);
                resolve(finalBuffer);
            });
            doc.on('error', reject);
            
            // Add header
            doc.rect(0, 0, doc.page.width, 120).fill('#4F46E5');
            
            doc.fillColor('#FFFFFF')
               .fontSize(28)
               .font('Helvetica-Bold')
               .text('MINERVAA VIDHYA MANDHIR', 50, 30, { align: 'center' })
               .fontSize(16)
               .text('Admission Enquiry Form', 50, 70, { align: 'center' });
            
            doc.fillColor('#FFFFFF')
               .fontSize(10)
               .text(`Generated on: ${new Date().toLocaleString()}`, 50, 100, { align: 'right' });
            
            let currentY = 140;
            
            // Student Photo section
            if (photoBuffer && photoBuffer.length > 0) {
                doc.fillColor('#1F2937')
                   .fontSize(14)
                   .font('Helvetica-Bold')
                   .text('STUDENT PHOTOGRAPH', 50, currentY);
                
                currentY += 25;
                
                doc.strokeColor('#4F46E5')
                   .lineWidth(2)
                   .rect(250, currentY, 100, 120)
                   .stroke();
                
                try {
                    doc.image(photoBuffer, 255, currentY + 5, {
                        width: 90,
                        height: 110,
                        fit: [90, 110]
                    });
                } catch (err) {
                    doc.fillColor('#EF4444')
                       .fontSize(10)
                       .text('Photo unavailable', 255, currentY + 55, {
                           width: 90,
                           align: 'center'
                       });
                }
                
                currentY += 140;
            } else {
                currentY += 20;
            }
            
            // Child Information
            if (currentY > 700) {
                doc.addPage();
                currentY = 50;
            }
            
            doc.fillColor('#4F46E5')
               .fontSize(16)
               .font('Helvetica-Bold')
               .text('CHILD INFORMATION', 50, currentY);
            
            currentY += 25;
            
            const childData = [
                ['Name of the Child', formData.childName || 'N/A'],
                ['Date of Birth', formData.dateOfBirth || 'N/A'],
                ['Sex', formData.sex || 'N/A'],
                ['Blood Group', formData.bloodGroup || 'N/A'],
                ['Contact Type', formData.contactType || 'N/A'],
                ['Contact Number', formData.contactNumber || 'N/A']
            ];
            
            currentY = createStyledTable(doc, ['Field', 'Details'], childData, currentY, [200, 300]);
            currentY += 20;
            
            // Father Details
            if (formData.fatherName && formData.fatherName.trim()) {
                if (currentY > 700) {
                    doc.addPage();
                    currentY = 50;
                }
                
                doc.fillColor('#4F46E5')
                   .fontSize(16)
                   .font('Helvetica-Bold')
                   .text('FATHER DETAILS', 50, currentY);
                
                currentY += 25;
                
                const fatherData = [
                    ['Name', formData.fatherName || 'N/A'],
                    ['Nationality', formData.fatherNationality || 'N/A'],
                    ['Occupation', formData.fatherOccupation || 'N/A'],
                    ['Office Address', formData.fatherOfficeAddress || 'N/A'],
                    ['Distance from School', formData.fatherDistance || 'N/A'],
                    ['Permanent Address', formData.fatherPermanentAddress || 'N/A'],
                    ['Monthly Income', formData.fatherIncome || 'N/A']
                ].filter(row => row[1] && row[1] !== 'N/A');
                
                if (fatherData.length > 0) {
                    currentY = createStyledTable(doc, ['Field', 'Details'], fatherData, currentY, [200, 300]);
                    currentY += 20;
                }
            }
            
            // Mother Details
            if (formData.motherName && formData.motherName.trim()) {
                if (currentY > 700) {
                    doc.addPage();
                    currentY = 50;
                }
                
                doc.fillColor('#4F46E5')
                   .fontSize(16)
                   .font('Helvetica-Bold')
                   .text('MOTHER DETAILS', 50, currentY);
                
                currentY += 25;
                
                const motherData = [
                    ['Name', formData.motherName || 'N/A'],
                    ['Nationality', formData.motherNationality || 'N/A'],
                    ['Occupation', formData.motherOccupation || 'N/A'],
                    ['Office Address', formData.motherOfficeAddress || 'N/A'],
                    ['Distance from School', formData.motherDistance || 'N/A'],
                    ['Permanent Address', formData.motherPermanentAddress || 'N/A'],
                    ['Monthly Income', formData.motherIncome || 'N/A']
                ].filter(row => row[1] && row[1] !== 'N/A');
                
                if (motherData.length > 0) {
                    currentY = createStyledTable(doc, ['Field', 'Details'], motherData, currentY, [200, 300]);
                    currentY += 20;
                }
            }
            
            // Academic Information
            if (currentY > 700) {
                doc.addPage();
                currentY = 50;
            }
            
            doc.fillColor('#4F46E5')
               .fontSize(16)
               .font('Helvetica-Bold')
               .text('ACADEMIC INFORMATION', 50, currentY);
            
            currentY += 25;
            
            const academicData = [
                ['Class Seeking Admission', formData.classAdmission || 'N/A'],
                ['TC Attached', formData.tcAttached || 'N/A'],
                ['How did you know about us', formData.howKnow || 'N/A']
            ];
            
            createStyledTable(doc, ['Field', 'Details'], academicData, currentY, [200, 300]);
            
            doc.end();
            
        } catch (error) {
            reject(error);
        }
    });
};

// Contact form submission endpoint
app.post('/api/contact', async (req, res) => {
    try {
        const { name, email, phone, message } = req.body;
        
        console.log('📞 Contact form submission from:', name);
        
        if (!name || !email || !phone || !message) {
            return res.status(400).json({ error: 'All fields are required' });
        }
        
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }
        
        // If no working email transporter, save to file
        if (!transporter) {
            const contactDir = path.join(__dirname, 'temp', 'contacts');
            await fs.ensureDir(contactDir);
            
            const filename = `contact_${Date.now()}.json`;
            const filepath = path.join(contactDir, filename);
            
            await fs.writeJSON(filepath, {
                name, email, phone, message,
                timestamp: new Date().toISOString()
            }, { spaces: 2 });
            
            console.log(`✅ Contact saved to file: ${filename}`);
            
            return res.status(200).json({
                success: true,
                message: 'Message received! We will contact you soon.'
            });
        }
        
        // Try to send email
        const adminMailOptions = {
            from: '"Minervaa School" <roobankr6@gmail.com>',
            to: 'suryareigns18@gmail.com',
            subject: `New Contact: ${name}`,
            html: `
                <h2>New Contact Form Submission</h2>
                <p><strong>Name:</strong> ${name}</p>
                <p><strong>Email:</strong> ${email}</p>
                <p><strong>Phone:</strong> ${phone}</p>
                <p><strong>Message:</strong></p>
                <p>${message.replace(/\n/g, '<br>')}</p>
            `
        };
        
        await transporter.sendMail(adminMailOptions);
        console.log(`✅ Contact email sent for ${name}`);
        
        res.status(200).json({
            success: true,
            message: 'Message sent successfully!'
        });
        
    } catch (error) {
        console.error('❌ Contact form error:', error);
        res.status(500).json({
            error: 'Failed to send message. Please try again.'
        });
    }
});

// Admission form submission endpoint
app.post('/api/admission', upload.single('photo'), async (req, res) => {
    try {
        const formData = req.body;
        const photoFile = req.file;
        
        console.log('📝 Admission form for:', formData.childName);
        
        // Validate required fields
        const requiredFields = ['childName', 'dateOfBirth', 'sex', 'contactType', 'contactNumber', 'classAdmission', 'tcAttached', 'howKnow'];
        const missingFields = requiredFields.filter(field => !formData[field]);
        
        if (missingFields.length > 0) {
            return res.status(400).json({
                error: `Missing fields: ${missingFields.join(', ')}`
            });
        }
        
        // Generate PDF
        let pdfBuffer;
        try {
            pdfBuffer = await generatePDF(formData, photoFile?.buffer);
        } catch (pdfError) {
            console.error('PDF generation failed:', pdfError);
            return res.status(500).json({
                error: 'Failed to generate form. Please try again.'
            });
        }
        
        // If no working email transporter, save to file system
        if (!transporter) {
            const savedPath = await saveFormToFile(formData, pdfBuffer, photoFile);
            
            return res.status(200).json({
                success: true,
                message: 'Application received! We will process it shortly.',
                reference: path.basename(savedPath)
            });
        }
        
        // Try to send email
        const mailOptions = {
            from: '"Minervaa Admissions" <roobankr6@gmail.com>',
            to: 'suryareigns18@gmail.com',
            subject: `New Admission: ${formData.childName}`,
            html: `
                <h2>New Admission Enquiry</h2>
                <p><strong>Student:</strong> ${formData.childName}</p>
                <p><strong>Class:</strong> ${formData.classAdmission}</p>
                <p><strong>Contact:</strong> ${formData.contactNumber}</p>
                <p><strong>DOB:</strong> ${formData.dateOfBirth}</p>
                <p>Full details in attached PDF</p>
            `,
            attachments: [
                {
                    filename: `Admission_${formData.childName.replace(/\s+/g, '_')}_${Date.now()}.pdf`,
                    content: pdfBuffer,
                    contentType: 'application/pdf'
                }
            ]
        };
        
        if (photoFile && photoFile.buffer) {
            mailOptions.attachments.push({
                filename: `Photo_${formData.childName.replace(/\s+/g, '_')}${path.extname(photoFile.originalname) || '.jpg'}`,
                content: photoFile.buffer,
                contentType: photoFile.mimetype || 'image/jpeg'
            });
        }
        
        // Send with shorter timeout
        const emailPromise = transporter.sendMail(mailOptions);
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Email timeout')), 30000);
        });
        
        await Promise.race([emailPromise, timeoutPromise]);
        
        console.log(`✅ Admission form sent for ${formData.childName}`);
        
        res.status(200).json({
            success: true,
            message: 'Application submitted successfully!'
        });
        
    } catch (error) {
        console.error('❌ Admission error:', error);
        
        // If email fails but we have the data, save to file as fallback
        try {
            const formData = req.body;
            const photoFile = req.file;
            const pdfBuffer = await generatePDF(formData, photoFile?.buffer);
            const savedPath = await saveFormToFile(formData, pdfBuffer, photoFile);
            
            res.status(200).json({
                success: true,
                message: 'Application received! We will contact you soon.',
                reference: path.basename(savedPath)
            });
        } catch (fallbackError) {
            res.status(500).json({
                error: 'Failed to process. Please try again or call us.'
            });
        }
    }
});

// Test email endpoint
app.get('/api/test-email', async (req, res) => {
    if (!transporter) {
        return res.json({ 
            success: false, 
            message: 'No working email configuration',
            note: 'Using file storage mode'
        });
    }
    
    try {
        const testMail = {
            from: '"Test" <roobankr6@gmail.com>',
            to: 'suryareigns18@gmail.com',
            subject: 'Test Email',
            text: 'If you receive this, email is working!'
        };
        
        await transporter.sendMail(testMail);
        res.json({ success: true, message: 'Test email sent!' });
    } catch (error) {
        console.error('Test email failed:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// List saved forms endpoint (admin only - protect this in production)
app.get('/api/admin/forms', async (req, res) => {
    try {
        const tempPath = path.join(__dirname, 'temp');
        const forms = [];
        
        const items = await fs.readdir(tempPath);
        
        for (const item of items) {
            const itemPath = path.join(tempPath, item);
            const stat = await fs.stat(itemPath);
            
            if (stat.isDirectory() && item.startsWith('admission_')) {
                try {
                    const dataPath = path.join(itemPath, 'data.json');
                    if (await fs.pathExists(dataPath)) {
                        const data = await fs.readJSON(dataPath);
                        forms.push({
                            id: item,
                            timestamp: stat.birthtime,
                            childName: data.childName,
                            classAdmission: data.classAdmission,
                            contactNumber: data.contactNumber
                        });
                    }
                } catch (err) {
                    console.error(`Error reading ${item}:`, err);
                }
            }
        }
        
        res.json({ success: true, forms });
    } catch (error) {
        console.error('Error listing forms:', error);
        res.status(500).json({ error: 'Failed to list forms' });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'OK',
        time: new Date().toISOString(),
        email: transporter ? 'configured' : 'fallback-mode',
        activeConfig: activeConfig?.name || 'none'
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('❌ Server error:', err);
    
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'File too large (max 5MB)' });
        }
    }
    
    res.status(500).json({ error: 'Server error' });
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log('\n🚀 ==================================');
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📧 Email: roobankr6@gmail.com`);
    console.log(`📨 Recipient: suryareigns18@gmail.com`);
    console.log('🔄 Testing email configurations...');
    console.log('🚀 ==================================\n');
});
