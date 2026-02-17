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
const sgMail = require('@sendgrid/mail');

const app = express();

// Trust proxy - required for rate limiting behind a proxy (like Render)
app.set('trust proxy', 1);

// Security middleware
app.use(helmet());

// CORS configuration
app.use(cors({
  origin: ['https://minevera-school-frontend.vercel.app', 'http://localhost:5173', 'http://localhost:5174'],
  credentials: true
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
    return req.path === '/health';
  }
});
app.use('/api/admission', limiter);
app.use('/api/contact', limiter);

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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
      if (!file.originalname.match(/\.(jpg|jpeg|png|gif)$/)) {
        return cb(new Error('Only image files are allowed!'), false);
      }
    }
    cb(null, true);
  }
});

// Configure SendGrid with API key from environment variables
if (!process.env.SENDGRID_API_KEY) {
  console.error('❌ SENDGRID_API_KEY is not set in environment variables');
  console.error('Please add it to your Render environment variables');
} else {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  console.log('✅ SendGrid configured successfully');
}

// SendGrid email sending function
async function sendEmailWithSendGrid(mailOptions) {
  try {
    // Convert attachments to base64 if they exist
    const attachments = mailOptions.attachments ? mailOptions.attachments.map(att => ({
      content: att.content.toString('base64'),
      filename: att.filename,
      type: att.contentType,
      disposition: 'attachment'
    })) : [];

    const msg = {
      to: mailOptions.to,
      from: process.env.FORM_EMAIL || 'roobankr6@gmail.com', // Verified sender in SendGrid
      subject: mailOptions.subject,
      html: mailOptions.html,
      text: mailOptions.text || '',
      attachments: attachments
    };

    console.log('📧 Sending email via SendGrid...');
    const response = await sgMail.send(msg);
    console.log('✅ Email sent via SendGrid');
    return response;
  } catch (error) {
    console.error('❌ SendGrid error details:');
    if (error.response) {
      console.error('SendGrid Response Body:', error.response.body);
    } else {
      console.error('SendGrid Error:', error.message);
    }
    throw error;
  }
}

// Helper function to create styled tables in PDF
const createStyledTable = (doc, headers, data, startY, columnWidths) => {
  const tableTop = startY;
  const rowHeight = 25;
  const cellPadding = 5;
  
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
      doc.text(cell?.toString() || 'N/A', xPosition + cellPadding, yPosition + 6, {
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
};

// Helper function to generate PDF
const generatePDF = async (formData, photoBuffer) => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ 
        size: 'A4', 
        margin: 50,
        info: {
          Title: `Admission Form - ${formData.childName}`,
          Author: 'Minervaa Vidhya Mandhir School'
        }
      });
      
      const chunks = [];
      
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      
      // Add decorative header
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
      if (photoBuffer) {
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
            valign: 'center'
          });
        } catch (err) {
          console.error('Error adding image to PDF:', err);
          doc.fillColor('#EF4444')
             .fontSize(10)
             .text('Photo attachment failed to load', 255, currentY + 55, { 
               width: 90, 
               align: 'center' 
             });
        }
        
        currentY += 140;
      } else {
        currentY += 20;
      }
      
      // Child Information Table
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
          ['Name', formData.fatherName],
          ['Nationality', formData.fatherNationality],
          ['Occupation', formData.fatherOccupation],
          ['Office Address', formData.fatherOfficeAddress],
          ['Distance from School', formData.fatherDistance],
          ['Permanent Address', formData.fatherPermanentAddress],
          ['Monthly Income', formData.fatherIncome]
        ].filter(row => row[1] && row[1].trim() !== '');
        
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
          ['Name', formData.motherName],
          ['Nationality', formData.motherNationality],
          ['Occupation', formData.motherOccupation],
          ['Office Address', formData.motherOfficeAddress],
          ['Distance from School', formData.motherDistance],
          ['Permanent Address', formData.motherPermanentAddress],
          ['Monthly Income', formData.motherIncome]
        ].filter(row => row[1] && row[1].trim() !== '');
        
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
          ['Name', formData.guardianName],
          ['Nationality', formData.guardianNationality],
          ['Occupation', formData.guardianOccupation],
          ['Office Address', formData.guardianOfficeAddress],
          ['Distance from School', formData.guardianDistance],
          ['Permanent Address', formData.guardianPermanentAddress],
          ['Monthly Income', formData.guardianIncome]
        ].filter(row => row[1] && row[1].trim() !== '');
        
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
      
      currentY = createStyledTable(
        doc, 
        ['Field', 'Details'], 
        academicData, 
        currentY, 
        [200, 300]
      );
      
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
    
    console.log('📞 Received contact form submission from:', name);
    
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
      from: process.env.FORM_EMAIL || '"Minervaa School Website" <roobankr6@gmail.com>',
      to: 'suryareigns18@gmail.com',
      subject: `New Contact Form Message - ${name}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%); color: white; padding: 20px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: #f9f9f9; padding: 20px; border: 1px solid #ddd; border-radius: 0 0 10px 10px; }
            .field { margin-bottom: 15px; padding: 15px; background: white; border-radius: 5px; border-left: 4px solid #4F46E5; }
            .label { font-weight: bold; color: #4F46E5; display: block; margin-bottom: 5px; }
            .value { color: #333; }
            .message-box { background: #f0f0f0; padding: 15px; border-radius: 5px; margin-top: 10px; }
            .footer { margin-top: 20px; text-align: center; color: #777; font-size: 12px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h2>New Contact Form Message</h2>
            </div>
            <div class="content">
              <div class="field">
                <span class="label">Name:</span>
                <span class="value">${name}</span>
              </div>
              <div class="field">
                <span class="label">Email:</span>
                <span class="value">${email}</span>
              </div>
              <div class="field">
                <span class="label">Phone:</span>
                <span class="value">${phone}</span>
              </div>
              <div class="field">
                <span class="label">Message:</span>
                <div class="message-box">${message.replace(/\n/g, '<br>')}</div>
              </div>
              <hr style="border: 1px solid #4F46E5; margin: 20px 0;">
              <p style="text-align: center; color: #666;">
                This message was sent from the contact form on the Minervaa Vidhya Mandhir School website.
              </p>
            </div>
            <div class="footer">
              <p>© ${new Date().getFullYear()} Minervaa Vidhya Mandhir School. All rights reserved.</p>
            </div>
          </div>
        </body>
        </html>
      `,
      text: `
        New Contact Form Message
        
        Name: ${name}
        Email: ${email}
        Phone: ${phone}
        
        Message:
        ${message}
        
        This message was sent from the contact form on the Minervaa Vidhya Mandhir School website.
      `
    };
    
    // Use SendGrid for contact form
    await sendEmailWithSendGrid(adminMailOptions);
    console.log(`✅ Contact form admin notification sent for ${name}`);
    
    res.status(200).json({ 
      success: true, 
      message: 'Your message has been sent successfully. We will contact you soon!' 
    });
    
  } catch (error) {
    console.error('❌ Error processing contact form:', error);
    
    res.status(500).json({ 
      error: 'Failed to send your message. Please try again or contact us directly by phone.' 
    });
  }
});

// Admission form submission endpoint - USING SENDGRID
app.post('/api/admission', upload.single('photo'), async (req, res) => {
  try {
    const formData = req.body;
    const photoFile = req.file;
    
    console.log('📝 Received admission form submission for:', formData.childName);
    console.log('Form data keys:', Object.keys(formData));
    
    // Validate required fields
    const requiredFields = ['childName', 'dateOfBirth', 'sex', 'contactType', 'contactNumber', 'classAdmission', 'tcAttached', 'howKnow'];
    const missingFields = requiredFields.filter(field => !formData[field]);
    
    if (missingFields.length > 0) {
      console.log('❌ Missing fields:', missingFields);
      return res.status(400).json({ 
        error: `Missing required fields: ${missingFields.join(', ')}` 
      });
    }
    
    console.log('✅ Validation passed, generating PDF...');
    
    // Generate PDF
    let pdfBuffer;
    try {
      pdfBuffer = await generatePDF(formData, photoFile?.buffer);
      console.log('✅ PDF generated successfully, size:', pdfBuffer.length, 'bytes');
    } catch (pdfError) {
      console.error('❌ PDF generation error:', pdfError);
      console.error('PDF error stack:', pdfError.stack);
      throw new Error(`PDF generation failed: ${pdfError.message}`);
    }
    
    console.log('📧 Preparing email with SendGrid...');
    
    // Prepare attachments array
    const attachments = [
      {
        filename: `Admission_Form_${formData.childName.replace(/\s+/g, '_')}_${Date.now()}.pdf`,
        content: pdfBuffer.toString('base64'),
        type: 'application/pdf',
        disposition: 'attachment'
      }
    ];
    
    // Add photo as attachment if available
    if (photoFile) {
      console.log('📸 Photo received:', photoFile.originalname, photoFile.mimetype, photoFile.size, 'bytes');
      attachments.push({
        filename: `Student_Photo_${formData.childName.replace(/\s+/g, '_')}${path.extname(photoFile.originalname)}`,
        content: photoFile.buffer.toString('base64'),
        type: photoFile.mimetype,
        disposition: 'attachment'
      });
    }
    
    // Prepare email message for SendGrid
    const msg = {
      to: 'suryareigns18@gmail.com',
      from: process.env.FORM_EMAIL || 'roobankr6@gmail.com', // Must be verified in SendGrid
      subject: `New Admission Enquiry - ${formData.childName}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%); color: white; padding: 20px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: #f9f9f9; padding: 20px; border: 1px solid #ddd; border-radius: 0 0 10px 10px; }
            .field { margin-bottom: 10px; padding: 10px; background: white; border-radius: 5px; }
            .label { font-weight: bold; color: #4F46E5; }
            .value { color: #333; margin-left: 10px; }
            .footer { margin-top: 20px; text-align: center; color: #777; font-size: 12px; }
            .highlight { background: #4F46E5; color: white; padding: 3px 10px; border-radius: 15px; display: inline-block; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h2>New Admission Enquiry</h2>
            </div>
            <div class="content">
              <div class="field">
                <span class="label">Student Name:</span>
                <span class="value">${formData.childName}</span>
              </div>
              <div class="field">
                <span class="label">Class Applying for:</span>
                <span class="value">${formData.classAdmission}</span>
              </div>
              <div class="field">
                <span class="label">Contact Number:</span>
                <span class="value">${formData.contactNumber}</span>
              </div>
              <div class="field">
                <span class="label">Date of Birth:</span>
                <span class="value">${formData.dateOfBirth}</span>
              </div>
              <hr style="border: 1px solid #4F46E5; margin: 20px 0;">
              <p style="text-align: center;">
                <span class="highlight">Complete admission form attached as PDF</span>
              </p>
            </div>
            <div class="footer">
              <p>This is an automated message from Minervaa Vidhya Mandhir School</p>
              <p>© ${new Date().getFullYear()} Minervaa Vidhya Mandhir School. All rights reserved.</p>
            </div>
          </div>
        </body>
        </html>
      `,
      attachments: attachments
    };
    
    console.log('📧 Sending email via SendGrid...');
    
    // Send email using SendGrid
    const response = await sgMail.send(msg);
    console.log('✅ Email sent via SendGrid, status code:', response[0].statusCode);
    console.log(`✅ Admission form email sent successfully for ${formData.childName}`);
    
    // Success response
    res.status(200).json({ 
      success: true, 
      message: 'Admission enquiry submitted successfully. We will contact you soon!' 
    });
    
  } catch (error) {
    console.error('❌❌❌ ERROR PROCESSING ADMISSION FORM ❌❌❌');
    console.error('Error name:', error.name);
    console.error('Error message:', error.message);
    
    // Detailed SendGrid error logging
    if (error.response) {
      console.error('SendGrid Response Status:', error.response.statusCode);
      console.error('SendGrid Response Body:', error.response.body);
    }
    
    console.error('Error stack:', error.stack);
    
    // Check for specific error types
    if (error.code === 'EAUTH' || (error.response && error.response.statusCode === 401)) {
      console.error('SendGrid authentication failed - check API key');
      return res.status(500).json({ 
        error: 'Email service configuration error. Please contact support.' 
      });
    }
    
    if (error.message.includes('PDF')) {
      return res.status(500).json({ 
        error: 'Failed to generate admission form. Please try again.' 
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to process admission form. Please try again or contact us directly.' 
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    message: 'Server is running',
    timestamp: new Date().toISOString()
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Global error:', err.stack);
  
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 5MB.' });
    }
  }
  
  res.status(err.status || 500).json({ 
    error: err.message || 'Internal Server Error' 
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log('🚀 ==================================');
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📧 Using SendGrid for email delivery`);
  console.log(`📨 Sending to: suryareigns18@gmail.com`);
  console.log(`✅ SendGrid API Key: ${process.env.SENDGRID_API_KEY ? 'Configured' : 'MISSING!'}`);
  console.log('🚀 ==================================');
});
