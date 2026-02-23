const nodemailer = require("nodemailer");
const validator = require("validator");
require("dotenv").config();

// Create transporter using environment variables
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.NODEMAILER_FORM_EMAIL,
    pass: process.env.NODEMAILER_FORM_EMAIL_PASSWORD,
  },
});

// Verify transporter on startup
transporter.verify((error, success) => {
  if (error) {
    console.error('❌ Email transporter verification failed:', error);
  } else {
    console.log('✅ Email transporter is ready');
  }
});

const sendEmail = async (...args) => {
  try {
    let receiverEmails, emailSubject, emailBody, ccEmails, attachments;
    
    // Handle both object and parameter formats
    if (args.length === 1 && typeof args[0] === 'object') {
      // Object format
      const emailData = args[0];
      receiverEmails = emailData.receiverEmails;
      emailSubject = emailData.subject || emailData.emailSubject;
      emailBody = emailData.body || emailData.emailBody;
      ccEmails = emailData.ccEmails || [];
      attachments = emailData.attachments || [];
    } else {
      // Parameter format
      [receiverEmails, emailSubject, emailBody, ccEmails = []] = args;
      attachments = [];
    }

    // Validate receiverEmails
    if (!receiverEmails) {
      console.error("Error: No recipients defined");
      return {
        success: false,
        error: "No recipients defined"
      };
    }

    const mailOptions = {
      from: `"Minervaa School" <${process.env.NODEMAILER_FORM_EMAIL}>`,
      to: receiverEmails,
      cc: ccEmails,
      subject: emailSubject,
      html: emailBody,
      attachments: attachments
    };

    const info = await transporter.sendMail(mailOptions);
    console.log("✅ Email sent successfully to:", receiverEmails);
    console.log("📧 Message ID:", info.messageId);
    
    if (attachments.length > 0) {
      console.log(`📎 ${attachments.length} attachment(s) included`);
    }

    return {
      success: true,
      message: "Email sent successfully",
      messageId: info.messageId
    };
  } catch (error) {
    console.error("❌ Error sending email:", error);
    return {
      success: false,
      error: error.message || "Failed to send email"
    };
  }
};

// Email validation function
const isValidEmail = (email) => {
  return validator.isEmail(email);
};

module.exports = { 
  sendEmail, 
  isValidEmail
};
