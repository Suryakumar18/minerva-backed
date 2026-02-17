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
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 50, // limit each IP to 50 requests per windowMs
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

// Configure multer for file uploads (memory storage)
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB limit
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

// Email configuration with better timeout handling
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587, // Changed from 465 to 587 for better compatibility
    secure: false, // false for 587
    auth: {
        user: 'roobankr6@gmail.com',
        pass: 'jvjkdwuhtmgvlldf'
    },
    // Increased timeouts
    connectionTimeout: 120000, // 2 minutes
    greetingTimeout: 60000,    // 1 minute
    socketTimeout: 120000,     // 2 minutes
    // TLS options
    tls: {
        rejectUnauthorized: false, // Only for development
        ciphers: 'SSLv3'
    },
    debug: true,
    logger: true,
    // Add pool configuration for better connection handling
    pool: true,
    maxConnections: 5,
    maxMessages: 100
});

// Verify email connection with retry logic
const verifyEmailConnection = async (retries = 3) => {
    for (let i = 0; i < retries; i++) {
        try {
            await transporter.verify();
            console.log('✅ Email server is ready to send messages');
            return true;
        } catch (error) {
            console.log(`⚠️ Email verification attempt ${i + 1} failed:`, error.message);
            if (i === retries - 1) {
                console.error('❌ All email verification attempts failed:', error);
                return false;
            }
            // Wait before retrying
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
    return false;
};

// Call verification
verifyEmailConnection();

// Helper function to create styled tables in PDF
const createStyledTable = (doc, headers, data, startY, columnWidths) => {
    try {
        const tableTop = startY;
        const rowHeight = 25;
        const cellPadding = 5;
        
        // Colors
        const headerBgColor = '#4F46E5';
        const headerTextColor = '#FFFFFF';
        const alternateRowColor = '#F3F4F6';
        const borderColor = '#E5E7EB';
        
        // Draw table headers
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
        
        // Draw table rows
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
                    Author: 'Minervaa Vidhya Mandhir School',
                    Creator: 'Minervaa School System',
                    Producer: 'PDFKit'
                }
            });
            
            const chunks = [];
            
            doc.on('data', chunk => chunks.push(chunk));
            doc.on('end', () => {
                const finalBuffer = Buffer.concat(chunks);
                console.log(`✅ PDF generated: ${finalBuffer.length} bytes`);
                resolve(finalBuffer);
            });
            doc.on('error', (err) => {
                console.error('PDF document error:', err);
                reject(err);
            });
            
            // Add header
            doc.rect(0, 0, doc.page.width, 120)
               .fill('#4F46E5');
            
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
                        align: 'center',
                        valign: 'center',
                        fit: [90, 110]
                    });
                } catch (err) {
                    console.error('Error adding image:', err);
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
            
            currentY = createStyledTable(
                doc,
                ['Field', 'Details'],
                childData,
                currentY,
                [200, 300]
            );
            
            currentY += 20;
            
            // Father Details
            if (formData.fatherName && formData.fatherName.trim() !== '') {
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
                    currentY = createStyledTable(
                        doc,
                        ['Field', 'Details'],
                        fatherData,
                        currentY,
                        [200, 300]
                    );
                    currentY += 20;
                }
            }
            
            // Mother Details
            if (formData.motherName && formData.motherName.trim() !== '') {
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
                    currentY = createStyledTable(
                        doc,
                        ['Field', 'Details'],
                        motherData,
                        currentY,
                        [200, 300]
                    );
                    currentY += 20;
                }
            }
            
            // Guardian Details
            if (formData.guardianName && formData.guardianName.trim() !== '') {
                if (currentY > 700) {
                    doc.addPage();
                    currentY = 50;
                }
                
                doc.fillColor('#4F46E5')
                   .fontSize(16)
                   .font('Helvetica-Bold')
                   .text('GUARDIAN DETAILS', 50, currentY);
                
                currentY += 25;
                
                const guardianData = [
                    ['Name', formData.guardianName || 'N/A'],
                    ['Nationality', formData.guardianNationality || 'N/A'],
                    ['Occupation', formData.guardianOccupation || 'N/A'],
                    ['Office Address', formData.guardianOfficeAddress || 'N/A'],
                    ['Distance from School', formData.guardianDistance || 'N/A'],
                    ['Permanent Address', formData.guardianPermanentAddress || 'N/A'],
                    ['Monthly Income', formData.guardianIncome || 'N/A']
                ].filter(row => row[1] && row[1] !== 'N/A');
                
                if (guardianData.length > 0) {
                    currentY = createStyledTable(
                        doc,
                        ['Field', 'Details'],
                        guardianData,
                        currentY,
                        [200, 300]
                    );
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
            
            createStyledTable(
                doc,
                ['Field', 'Details'],
                academicData,
                currentY,
                [200, 300]
            );
            
            console.log('Finalizing PDF...');
            doc.end();
            
        } catch (error) {
            console.error('❌ PDF generation error:', error);
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
            return res.status(400).json({
                error: 'All fields are required'
            });
        }
        
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({
                error: 'Please provide a valid email address'
            });
        }
        
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
            `,
            text: `
                New Contact Form Submission
                Name: ${name}
                Email: ${email}
                Phone: ${phone}
                Message: ${message}
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
            // Try without photo
            pdfBuffer = await generatePDF(formData, null);
        }
        
        // Prepare email
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
        
        // Add photo if available
        if (photoFile && photoFile.buffer) {
            mailOptions.attachments.push({
                filename: `Photo_${formData.childName.replace(/\s+/g, '_')}${path.extname(photoFile.originalname) || '.jpg'}`,
                content: photoFile.buffer,
                contentType: photoFile.mimetype || 'image/jpeg'
            });
        }
        
        // Send email with timeout
        const emailPromise = transporter.sendMail(mailOptions);
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Email timeout')), 60000);
        });
        
        await Promise.race([emailPromise, timeoutPromise]);
        
        console.log(`✅ Admission form sent for ${formData.childName}`);
        
        res.status(200).json({
            success: true,
            message: 'Application submitted successfully!'
        });
        
    } catch (error) {
        console.error('❌ Admission error:', error);
        
        // Provide appropriate error message
        if (error.message === 'Email timeout') {
            res.status(500).json({
                error: 'Email service timeout. Please try again.'
            });
        } else {
            res.status(500).json({
                error: 'Failed to process. Please try again or call us.'
            });
        }
    }
});

// Test email endpoint
app.get('/api/test-email', async (req, res) => {
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

// Health check
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'OK',
        time: new Date().toISOString(),
        email: 'configured'
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
    console.log('🚀 ==================================\n');
});
