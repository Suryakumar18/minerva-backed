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
require('dotenv').config(); // Make sure dotenv is loaded at the top

// IMPORTANT: Import your email utility
const { sendEmail } = require('./mail'); // Make sure this path is correct

const app = express();

// Trust proxy - required for rate limiting behind a proxy (like Render)
app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// CORS configuration - update with your frontend URLs
app.use(cors({
  origin: [
    'http://localhost:3001', 
    'http://localhost:5173', 
    'http://localhost:5174',
    'https://minevera-school-frontend.vercel.app', // Add your Vercel frontend URL
    'https://minervaa-school.vercel.app' // Example - update with your actual URL
  ],
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
      // Accept images only
      if (!file.originalname.match(/\.(jpg|jpeg|png|gif)$/)) {
        return cb(new Error('Only image files are allowed!'), false);
      }
    }
    cb(null, true);
  }
});


// Helper function to create styled tables in PDF
const createStyledTable = (doc, headers, data, startY, columnWidths) => {
  const tableTop = startY;
  const rowHeight = 25;
  const cellPadding = 5;
  
  // Colors
  const headerBgColor = '#4F46E5'; // Indigo
  const headerTextColor = '#FFFFFF';
  const alternateRowColor = '#F3F4F6'; // Light gray
  const borderColor = '#E5E7EB'; // Gray border
  
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
    // Alternate row background
    if (rowIndex % 2 === 0) {
      doc.fillColor(alternateRowColor);
      doc.rect(50, yPosition, 500, rowHeight).fill();
    }
    
    // Draw row borders
    doc.strokeColor(borderColor).lineWidth(0.5);
    
    // Draw vertical lines
    let lineX = 50;
    for (let i = 0; i <= columnWidths.length; i++) {
      doc.moveTo(lineX, yPosition)
         .lineTo(lineX, yPosition + rowHeight)
         .stroke();
      if (i < columnWidths.length) lineX += columnWidths[i];
    }
    
    // Draw horizontal lines
    doc.moveTo(50, yPosition)
       .lineTo(550, yPosition)
       .stroke();
    
    // Draw cell content
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
  
  // Draw bottom border
  doc.moveTo(50, yPosition)
     .lineTo(550, yPosition)
     .stroke();
  
  // Reset fill color
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
        
        // Create a frame for the photo
        doc.strokeColor('#4F46E5')
           .lineWidth(2)
           .rect(250, currentY, 100, 120)
           .stroke();
        
        try {
          // Center the image in the frame
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
      
      // Check if we need a new page for child information
      if (currentY > 700) {
        doc.addPage();
        currentY = 50;
      }
      
      // Child Information Table
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
        // Check if we need a new page
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
        ].filter(row => row[1] && row[1].trim() !== ''); // Remove empty rows
        
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
        // Check if we need a new page
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
        ].filter(row => row[1] && row[1].trim() !== ''); // Remove empty rows
        
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
        // Check if we need a new page
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
        ].filter(row => row[1] && row[1].trim() !== ''); // Remove empty rows
        
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
      // Check if we need a new page
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
    
    // Validate required fields
    if (!name || !email || !phone || !message) {
      return res.status(400).json({ 
        error: 'All fields are required' 
      });
    }
    
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ 
        error: 'Please provide a valid email address' 
      });
    }
    
    // Prepare email options for admin notification
    const adminMailOptions = {
      receiverEmails: process.env.ADMIN_EMAIL || 'suryareigns18@gmail.com', // Use env var or fallback
      subject: `New Contact Form Message - ${name}`,
      body: `
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
      `
    };
    
    // Prepare auto-reply email for the user
    const userMailOptions = {
      receiverEmails: email,
      subject: 'Thank You for Contacting Minervaa Vidhya Mandhir School',
      body: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%); color: white; padding: 20px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: #f9f9f9; padding: 20px; border: 1px solid #ddd; border-radius: 0 0 10px 10px; }
            .message { background: white; padding: 20px; border-radius: 5px; margin: 20px 0; }
            .footer { margin-top: 20px; text-align: center; color: #777; font-size: 12px; }
            .signature { margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; }
            .school-name { color: #4F46E5; font-weight: bold; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h2>Thank You for Contacting Us!</h2>
            </div>
            <div class="content">
              <p>Dear ${name},</p>
              
              <p>Thank you for reaching out to <span class="school-name">Minervaa Vidhya Mandhir School</span>. We have received your message and appreciate your interest in our institution.</p>
              
              <div class="message">
                <p><strong>Your Message:</strong></p>
                <p>${message.replace(/\n/g, '<br>')}</p>
              </div>
              
              <p>Our team will review your inquiry and get back to you as soon as possible. Typically, we respond within 24-48 hours during business days.</p>
              
              <div class="signature">
                <p>Warm regards,<br>
                <strong>Admissions Office</strong><br>
                <span class="school-name">Minervaa Vidhya Mandhir School</span><br>
                Pollachi, Tamil Nadu</p>
              </div>
            </div>
            <div class="footer">
              <p>© ${new Date().getFullYear()} Minervaa Vidhya Mandhir School. All rights reserved.</p>
            </div>
          </div>
        </body>
        </html>
      `
    };
    
    // Send email to admin using your email utility
    const adminResult = await sendEmail(adminMailOptions);
    
    if (!adminResult.success) {
      console.error('Failed to send admin email:', adminResult.error);
      // Still try to send user email
    }
    
    // Send auto-reply to user
    const userResult = await sendEmail(userMailOptions);
    
    if (adminResult.success && userResult.success) {
      console.log(`✅ Contact form emails sent successfully for ${name}`);
      res.status(200).json({ 
        success: true, 
        message: 'Your message has been sent successfully. We will contact you soon!' 
      });
    } else {
      // Partial success
      res.status(200).json({ 
        success: true, 
        message: 'Your message has been received. We will contact you soon!',
        warning: 'Email notification partially failed but your enquiry was received.'
      });
    }
    
  } catch (error) {
    console.error('❌ Error processing contact form:', error);
    res.status(500).json({ 
      error: 'Failed to send your message. Please try again or contact us directly by phone.' 
    });
  }
});

// Admission form submission endpoint
app.post('/api/admission', upload.single('photo'), async (req, res) => {
  try {
    const formData = req.body;
    const photoFile = req.file;
    
    console.log('📝 Received admission form submission for:', formData.childName);
    
    // Validate required fields
    const requiredFields = ['childName', 'dateOfBirth', 'sex', 'contactType', 'contactNumber', 'classAdmission', 'tcAttached', 'howKnow'];
    const missingFields = requiredFields.filter(field => !formData[field]);
    
    if (missingFields.length > 0) {
      return res.status(400).json({ 
        error: `Missing required fields: ${missingFields.join(', ')}` 
      });
    }
    
    // Generate PDF (if you have this function)
    // const pdfBuffer = await generatePDF(formData, photoFile?.buffer);
    
    // Prepare email content
    const emailSubject = `New Admission Enquiry - ${formData.childName}`;
    
    // Create a formatted HTML email body
    const emailBody = `
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
          .section-title { color: #4F46E5; font-size: 18px; margin: 20px 0 10px 0; border-bottom: 2px solid #4F46E5; padding-bottom: 5px; }
          .footer { margin-top: 20px; text-align: center; color: #777; font-size: 12px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2>🏫 New Admission Enquiry</h2>
            <p>Minervaa Vidhya Mandhir School</p>
          </div>
          <div class="content">
            <div class="section-title">Student Information</div>
            <div class="field">
              <span class="label">Student Name:</span>
              <span class="value">${formData.childName}</span>
            </div>
            <div class="field">
              <span class="label">Date of Birth:</span>
              <span class="value">${formData.dateOfBirth}</span>
            </div>
            <div class="field">
              <span class="label">Gender:</span>
              <span class="value">${formData.sex}</span>
            </div>
            
            <div class="section-title">Contact Information</div>
            <div class="field">
              <span class="label">Contact Type:</span>
              <span class="value">${formData.contactType}</span>
            </div>
            <div class="field">
              <span class="label">Contact Number:</span>
              <span class="value">${formData.contactNumber}</span>
            </div>
            ${formData.alternateNumber ? `
            <div class="field">
              <span class="label">Alternate Number:</span>
              <span class="value">${formData.alternateNumber}</span>
            </div>
            ` : ''}
            ${formData.email ? `
            <div class="field">
              <span class="label">Email:</span>
              <span class="value">${formData.email}</span>
            </div>
            ` : ''}
            
            <div class="section-title">Admission Details</div>
            <div class="field">
              <span class="label">Class Applying for:</span>
              <span class="value">${formData.classAdmission}</span>
            </div>
            <div class="field">
              <span class="label">TC Attached:</span>
              <span class="value">${formData.tcAttached}</span>
            </div>
            
            <hr style="border: 1px solid #4F46E5; margin: 20px 0;">
            
            ${photoFile ? `
            <p style="text-align: center; background: #e8f4fd; padding: 10px; border-radius: 5px;">
              <strong>📸 Student Photo is attached with this email</strong><br>
              <span style="font-size: 12px;">${photoFile.originalname} (${(photoFile.size / 1024).toFixed(2)} KB)</span>
            </p>
            ` : `
            <p style="text-align: center; background: #fff3cd; padding: 10px; border-radius: 5px;">
              <strong>📸 No photo was uploaded</strong>
            </p>
            `}
            
            <p style="font-size: 14px; color: #666; text-align: center;">
              <strong>Submitted on:</strong> ${new Date().toLocaleString()}
            </p>
          </div>
          <div class="footer">
            <p>This is an automated message from Minervaa Vidhya Mandhir School</p>
            <p>© ${new Date().getFullYear()} Minervaa Vidhya Mandhir School. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    // Prepare attachments array
    const attachments = [];
    
    // Add photo as attachment if available
    if (photoFile) {
      const fileExtension = photoFile.originalname.split('.').pop();
      attachments.push({
        filename: `Student_Photo_${formData.childName.replace(/\s+/g, '_')}_${Date.now()}.${fileExtension}`,
        content: photoFile.buffer,
        contentType: photoFile.mimetype
      });
    }

    // If you have PDF generation, add it as attachment
    // if (pdfBuffer) {
    //   attachments.push({
    //     filename: `Admission_Form_${formData.childName.replace(/\s+/g, '_')}_${Date.now()}.pdf`,
    //     content: pdfBuffer,
    //     contentType: 'application/pdf'
    //   });
    // }

    // Send email using your email utility
    const emailResult = await sendEmail({
      receiverEmails: process.env.ADMIN_EMAIL || 'roobankr6@gmail.com', // Use env var or fallback
      subject: emailSubject,
      body: emailBody,
      attachments: attachments
    });

    if (emailResult.success) {
      console.log(`✅ Admission form email sent successfully for ${formData.childName}`);
      if (photoFile) {
        console.log(`📸 Photo attached: ${photoFile.originalname}`);
      }
      
      res.status(200).json({ 
        success: true, 
        message: 'Admission enquiry submitted successfully. We will contact you soon!' 
      });
    } else {
      console.error('❌ Failed to send email:', emailResult.error);
      
      // Still return success to user but log the email failure
      res.status(200).json({ 
        success: true, 
        message: 'Admission enquiry submitted successfully. We will contact you soon!',
        warning: 'Email notification failed but your enquiry was received.'
      });
    }
    
  } catch (error) {
    console.error('❌ Error processing admission form:', error);
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
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
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
  console.log(`📧 Email configured for: ${process.env.NODEMAILER_FORM_EMAIL}`);
  console.log(`📨 Sending to admin: ${process.env.ADMIN_EMAIL || 'roobankr6@gmail.com'}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log('🚀 ==================================');
});

