const nodemailer = require("nodemailer");
const validator = require("validator");
require("dotenv").config();

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.NODEMAILER_FORM_EMAIL,
    pass: process.env.NODEMAILER_FORM_EMAIL_PASSWORD,
  },
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
      attachments = emailData.attachments || []; // Add this line
    } else {
      // Parameter format
      [receiverEmails, emailSubject, emailBody, ccEmails = []] = args;
      attachments = []; // Default empty attachments
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
      from: process.env.NODEMAILER_FORM_EMAIL,
      to: receiverEmails,
      cc: ccEmails,
      subject: emailSubject,
      html: emailBody,
      attachments: attachments // Add attachments to mailOptions
    };

    await transporter.sendMail(mailOptions);
    console.log("Email sent successfully to:", receiverEmails);
    if (attachments.length > 0) {
      console.log(`📎 ${attachments.length} attachment(s) included`);
    }

    return {
      success: true,
      message: "Email sent successfully"
    };
  } catch (error) {
    console.error("Error sending email:", error);
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
