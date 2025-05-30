import { Record, RecordStatus } from '../models/record.model';
import { User } from '../models/user.model';
import { Cabinet, CustomField, CabinetApprover } from '../models/cabinet.model';
import { AppError } from '../presentation/middlewares/errorHandler';
import { Op } from 'sequelize';
import { RecordVersion } from '../models/record-version.model';
import { sequelize } from '../infrastructure/database/sequelize';
import { CabinetMember } from '../models/cabinet-member.model';
import { RecordNoteComment } from '../models/record-note-comment.model';
import { PdfFile } from '../models/pdf-file.model';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import fileService from './file.service';
import { ActivityService } from './activity.service';
import { ActivityType, ResourceType } from '../models/activity.model';
import { NotificationService } from './notification.service';
import RecordOtherVersion from '../models/recordOtherVersion.model';

const { PDFExtract } = require('pdf.js-extract');
const pdfExtract = new PDFExtract();

// For file operations
const writeFileAsync = promisify(fs.writeFile);
const readFileAsync = promisify(fs.readFile);
const UPLOAD_DIR = path.join(process.cwd(), 'uploads');

// Make sure the upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

interface CustomFieldValue {
  fieldId: number;
  value: any;
  type: string;
  fileName?: string;
  fileSize?: number;
  fileType?: string;
  filePath?: string;
  fileHash?: string;
}

interface ModifyRecordData {
  recordId: string;
  title: string;
  cabinetId: string;
  creatorId: string;
  customFields: { [key: string]: any };
  status: string;
  tags: string[];
  pdfFile?: Express.Multer.File;
}

interface ExtendedCustomField extends CustomField {
  characterLimit?: number;
}

interface PdfExtractResult {
  extractedText: string;
  extractedFields: { name: string; value: string }[];
  pageCount: number;
}

// Enhanced PDF extractor that analyzes content using pdf.js-extract
async function extractPdfContent(file: Express.Multer.File): Promise<PdfExtractResult> {
  try {
    // Save file temporarily for extraction
    const tempPath = path.join(UPLOAD_DIR, `temp_${Date.now()}.pdf`);
    await writeFileAsync(tempPath, file.buffer);
    
    // Extract data from PDF
    const extractOptions = {};
    const pdfData = await pdfExtract.extract(tempPath, extractOptions);
    
    // Clean up temp file
    fs.unlink(tempPath, (err) => {
      if (err) console.error('Error removing temp file:', err);
    });
    
    // Process the extracted data
    const pageCount = pdfData.pages.length;
    let extractedText = '';
    const extractedFields: { name: string; value: string }[] = [];
    
    // Extract text and look for key-value pairs
    for (const page of pdfData.pages) {
      // Sort content by y position to maintain reading order
      const sortedContent = [...page.content].sort((a, b) => a.y - b.y);
      
      // Join text by line
      let currentY = -1;
      let currentLine = '';
      
      for (const item of sortedContent) {
        if (Math.abs(item.y - currentY) > 1) {
          // New line detected
          if (currentLine) {
            extractedText += currentLine + '\n';
            
            // Try to extract key-value pairs
            const colonMatch = currentLine.match(/([^:]+):\s*(.*)/);
            if (colonMatch && colonMatch[1] && colonMatch[2]) {
              const key = colonMatch[1].trim();
              const value = colonMatch[2].trim();
              
              // Skip empty values and very short keys
              if (value && key.length > 1) {
                extractedFields.push({
                  name: key,
                  value: value
                });
              }
            }
            
            // Reset current line
            currentLine = '';
          }
          currentY = item.y;
        }
        
        // Add text to current line
        currentLine += item.str + ' ';
      }
      
      // Don't forget the last line
      if (currentLine) {
        extractedText += currentLine + '\n';
      }
    }
    
    // Analyze the extracted text for structure (tables, lists, etc.)
    const lines = extractedText.split('\n');
    const structuredExtraction = analyzeTextStructure(lines);
    
    // Combine basic extraction with structured analysis
    return {
      extractedText,
      extractedFields: [...extractedFields, ...structuredExtraction],
      pageCount
    };
  } catch (error) {
    console.error('Error extracting PDF content:', error);
    throw new AppError(500, 'Failed to process PDF file');
  }
}

// Helper function to analyze text structure for additional field extraction
function analyzeTextStructure(lines: string[]): { name: string; value: string }[] {
  const extractedFields: { name: string; value: string }[] = [];
  
  // Detect tables, forms, address blocks, etc.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    // Look for address blocks
    if (line.match(/bill to|ship to|address|customer|client/i) && i + 1 < lines.length) {
      let addressValue = '';
      let j = i + 1;
      while (j < lines.length && j < i + 5) {
        const addressLine = lines[j].trim();
        if (!addressLine || addressLine.includes(':')) break;
        addressValue += addressLine + ' ';
        j++;
      }
      
      if (addressValue.trim()) {
        extractedFields.push({
          name: line.replace(':', '').trim(),
          value: addressValue.trim()
        });
      }
    }
    
    // Common invoice fields
    const commonFields = ['invoice', 'date', 'due date', 'subtotal', 'tax', 'total', 'amount', 'payment', 'po number'];
    for (const field of commonFields) {
      if (line.toLowerCase().includes(field)) {
        // Try to extract value from same line or next line
        let value = '';
        
        // Check if there's already a value after the field name
        if (line.includes(':')) {
          const parts = line.split(':');
          if (parts.length > 1 && parts[1].trim()) {
            value = parts[1].trim();
          }
        }
        // Look for numeric value on same line
        else if (/\d/.test(line)) {
          const words = line.split(/\s+/);
          const numericWords = words.filter(w => /\d/.test(w));
          if (numericWords.length > 0) {
            // If field is at beginning and there's a number after
            if (line.toLowerCase().startsWith(field) && numericWords.length > 0) {
              value = numericWords.join(' ');
            }
            // Other patterns based on field type
            else if (field === 'total' || field === 'subtotal' || field === 'amount' || field === 'tax') {
              // Look for currency formats
              const currencyMatch = line.match(/[\$€£]\s*[\d,]+\.?\d*/);
              if (currencyMatch) {
                value = currencyMatch[0];
              } else {
                value = numericWords.join(' ');
              }
            } else if (field === 'date' || field === 'due date') {
              // Look for date formats
              const dateMatch = line.match(/\d{1,4}[\/-]\d{1,2}[\/-]\d{1,4}|\d{1,2}\s+[A-Za-z]+\s+\d{1,4}/);
              if (dateMatch) {
                value = dateMatch[0];
              } else {
                value = numericWords.join(' ');
              }
            } else {
              value = numericWords.join(' ');
            }
          }
        }
        // If no value found, check next line
        else if (!value && i + 1 < lines.length) {
          const nextLine = lines[i + 1].trim();
          if (nextLine && !/\w+\s*:/.test(nextLine)) {
            value = nextLine;
          }
        }
        
        if (value) {
          const fieldName = field.charAt(0).toUpperCase() + field.slice(1);
          
          // Avoid duplicates
          if (!extractedFields.some(ef => ef.name.toLowerCase() === fieldName.toLowerCase())) {
            extractedFields.push({
              name: fieldName,
              value: value
            });
          }
        }
      }
    }
  }
  
  return extractedFields;
}

export class RecordService {
  
  static async createRecord(data: {
    title: string;
    cabinetId: string;
    creatorId: string;
    customFields: { [key: string]: any };
    status: RecordStatus;
    isTemplate: boolean;
    isActive: boolean;
    tags: string[];
    pdfFile?: Express.Multer.File;
  }) {
    // Validate title
    if (!data.title || !data.title.trim()) {
      throw new AppError(400, 'Record title is required');
    }

    // Validate cabinet exists and get its custom fields configuration
    const cabinet = await Cabinet.findByPk(data.cabinetId);
    if (!cabinet) {
      throw new AppError(400, 'Cabinet not found');
    }

    // Validate creator exists
    const creator = await User.findByPk(data.creatorId);
    if (!creator) {
      throw new AppError(400, 'Creator not found');
    }

    // Validate custom fields against cabinet configuration
    const validatedFields = await RecordService.validateCustomFields(data.customFields, cabinet.customFields);

    // Find the first attachment field if any
    let fileInfo = null;
    for (const fieldId in validatedFields) {
      const field = validatedFields[fieldId];
      if (field.type === 'Attachment' && field.value) {
        fileInfo = field.value;
        break;
      }
    }

    // Start a transaction for the record creation
    const transaction = await sequelize.transaction();

    try {
      // Create record with validated fields and file information
      const record = await Record.create({
        ...data,
        title: data.title.trim(),
        customFields: validatedFields,
        lastModifiedBy: data.creatorId,
        version: 1,
        // Add file information if present
        ...(fileInfo && {
          fileName: fileInfo.fileName,
          filePath: fileInfo.filePath,
          fileSize: fileInfo.fileSize,
          fileType: fileInfo.fileType,
          fileHash: fileInfo.fileHash,
        })
      }, { transaction });

      // If a PDF file was provided, try to process it but don't fail record creation if it fails
      if (data.pdfFile) {
        try {
          // Process PDF with proper error handling
          let pdfData;
          try {
            pdfData = await extractPdfContent(data.pdfFile);
          } catch (pdfError) {
            console.error('PDF processing error (non-fatal):', pdfError);
            // Use fallback data when PDF processing fails
            pdfData = {
              extractedText: 'PDF text extraction failed',
              extractedFields: [
                { name: 'Document Name', value: data.pdfFile.originalname },
                { name: 'File Size', value: `${Math.round(data.pdfFile.size / 1024)} KB` }
              ],
              pageCount: 1
            };
          }
          
          // Generate a unique filename for the PDF
          const timestamp = Date.now();
          const pdfFileName = `${timestamp}-${data.pdfFile.originalname.replace(/\s+/g, '_')}`;
          const pdfFilePath = path.join(UPLOAD_DIR, pdfFileName);
          
          // Ensure upload directory exists
          if (!fs.existsSync(UPLOAD_DIR)) {
            fs.mkdirSync(UPLOAD_DIR, { recursive: true });
          }
          
          // Save the PDF file to disk
          await writeFileAsync(pdfFilePath, data.pdfFile.buffer);
          
          // Create a new PDF file record
          await PdfFile.create({
            recordId: record.id,
            originalFileName: data.pdfFile.originalname,
            filePath: pdfFilePath,
            fileSize: data.pdfFile.size,
            fileHash: 'N/A', // In a real implementation, would calculate an actual hash
            pageCount: pdfData.pageCount,
            extractedText: pdfData.extractedText,
            extractedMetadata: {
              fields: pdfData.extractedFields
            }
          }, { transaction });
        } catch (pdfStoreError) {
          // Log error but continue with record creation
          console.error('Failed to store PDF file (continuing with record creation):', pdfStoreError);
        }
      }

      // Commit the transaction
      await transaction.commit();
      return record;
    } catch (error) {
      // Rollback transaction in case of error
      await transaction.rollback();
      throw error;
    }
  }

  /**
   * Process a PDF file to extract text and metadata
   */
  static async processPdfFile(file: Express.Multer.File): Promise<PdfExtractResult> {
    try {
      return await extractPdfContent(file);
    } catch (error) {
      console.error('Error in processPdfFile:', error);
      
      // Return basic information even if detailed extraction fails
      return {
        extractedText: 'PDF text extraction failed',
        extractedFields: [
          { name: 'Document Name', value: file.originalname },
          { name: 'File Size', value: `${Math.round(file.size / 1024)} KB` }
        ],
        pageCount: 1
      };
    }
  }

  /**
   * Get a record with its PDF file
   */
  static async getRecordWithPdf(id: string) {
    const record = await Record.findByPk(id, {
      include: [
        {
          model: Cabinet,
          as: 'cabinet'
        },
        {
          model: User,
          as: 'creator'
        },
        {
          model: PdfFile,
          as: 'pdfFile'
        },
        {
          model: RecordNoteComment,
          as: 'notes',
          where: { type: 'note' },
          required: false,
          include: [{
            model: User,
            as: 'creator',
            attributes: ['id', 'firstName', 'lastName']
          }],
          order: [['createdAt', 'DESC']],
          limit: 1
        },
        {
          model: RecordNoteComment,
          as: 'comments',
          where: { type: 'comment' },
          required: false,
          include: [{
            model: User,
            as: 'creator',
            attributes: ['id', 'firstName', 'lastName']
          }],
          order: [['createdAt', 'DESC']]
        }
      ]
    });

    if (!record) {
      throw new AppError(400, 'Record not found');
    }

    return record;
  }

  static async validateCustomFields(
    submittedFields: { [key: string]: any },
    cabinetFields: ExtendedCustomField[]
  ): Promise<{ [key: string]: CustomFieldValue }> {
    const validatedFields: { [key: string]: CustomFieldValue } = {};

   
    for (const field of cabinetFields) {
     // console.log(`Processing field: ${field.name} (${field.type})`);
      
      const submittedField = submittedFields[field.id];
     // console.log('Submitted field value:', submittedField);

      // Handle mandatory field validation
      if (field.isMandatory) {
       // console.log(`Field ${field.name} is mandatory`);
        
        if (field.type === 'Attachment') {
          // For attachment fields, check if there's a valid value object
          const hasValidValue = submittedField && 
            ((submittedField.value && Object.keys(submittedField.value).length > 0) || 
             (typeof submittedField === 'object' && (submittedField.filePath || submittedField.fileName)));
          
         // console.log('Attachment field validation:', {
          //  hasValidValue,
          //  submittedField: submittedField
          //});

          if (!hasValidValue) {
            throw new AppError(400, `Field '${field.name}' is mandatory`);
          }
        } else {
          // For non-attachment fields
          const hasValue = submittedField !== undefined && submittedField !== null && submittedField !== '';
          
         // console.log('Non-attachment field validation:', {
          //  hasValue,
          //  submittedField: submittedField
          //});

          if (!hasValue) {
            throw new AppError(400, `Field '${field.name}' is mandatory`);
          }
        }
      }

      // Process the field based on its type
      if (field.type === 'Attachment') {
        if (submittedField) {
          validatedFields[field.id] = {
            fieldId: field.id,
            type: field.type,
            value: submittedField
          };
        }
      } else {
        if (submittedField !== undefined) {
          validatedFields[field.id] = {
            fieldId: field.id,
            type: field.type,
            value: await RecordService.validateFieldValue(submittedField, field)
          };
        }
      }

     // console.log(`Validated field ${field.name}:`, validatedFields[field.id]);
    }

    return validatedFields;
  }

  private static async validateFieldValue(value: any, field: ExtendedCustomField): Promise<any> {
    if (value === undefined || value === null) {
      return null;
    }

    // Extract value from complex object if needed
    const actualValue = typeof value === 'object' && value !== null
      ? value.value !== undefined ? value.value : value
      : value;

    switch (field.type) {
      case 'Text/Number with Special Symbols':
        // Handle null, undefined, or empty string
        if (actualValue === null || actualValue === undefined || actualValue === '') {
          return null;
        }

        // Convert to string if it's a number
        const stringValue = typeof actualValue === 'number' ? actualValue.toString() : actualValue;

        // Check if it's a string
        if (typeof stringValue !== 'string') {
          throw new AppError(400, `Field '${field.name}' must be text, number or special symbols`);
        }

        // Check character limit if specified
        if (field.characterLimit && stringValue.length > field.characterLimit) {
          throw new AppError(400, `Field '${field.name}' exceeds character limit of ${field.characterLimit}`);
        }

        // Allow any combination of text, numbers and special symbols
        return stringValue;

      case 'Text Only':
        // Handle object with value property
        const textValue = typeof actualValue === 'object' && actualValue !== null && 'value' in actualValue 
          ? actualValue.value 
          : actualValue;

        if (typeof textValue !== 'string') {
          throw new AppError(400, `Field '${field.name}' must be text`);
        }
        if (field.characterLimit && textValue.length > field.characterLimit) {
          throw new AppError(400, `Field '${field.name}' exceeds character limit of ${field.characterLimit}`);
        }
        return textValue;

      case 'Number Only':
        // Handle null, undefined, or empty string
        if (actualValue === null || actualValue === undefined || actualValue === '') {
          return null;
        }

        // If value is already a number, use it directly
        if (typeof actualValue === 'number') {
          if (isNaN(actualValue)) {
            throw new AppError(400, `Field '${field.name}' must be a valid number`);
          }
          return actualValue;
        }

        // If value is a string, try to parse it
        if (typeof actualValue === 'string') {
          const num = parseFloat(actualValue.trim());
          if (isNaN(num)) {
            throw new AppError(400, `Field '${field.name}' must be a valid number`);
          }
          return num;
        }

        throw new AppError(400, `Field '${field.name}' must be a valid number`);

      case 'Currency':
        const amount = Number(actualValue);
        if (isNaN(amount)) {
          throw new AppError(400, `Field '${field.name}' must be a valid currency amount`);
        }
        return amount;

      case 'Date':
      case 'Time':
      case 'Time and Date':
        // If the value is already an ISO string, return it
        if (typeof actualValue === 'string' && !isNaN(new Date(actualValue).getTime())) {
          return actualValue;
        }

        const date = new Date(actualValue);
        if (isNaN(date.getTime())) {
          throw new AppError(400, `Field '${field.name}' must be a valid date/time`);
        }
        return date.toISOString();

      case 'Yes/No':
        if (typeof actualValue !== 'boolean') {
          throw new AppError(400, `Field '${field.name}' must be a boolean`);
        }
        return actualValue;

      case 'Tags/Labels':
        if (!Array.isArray(actualValue)) {
          throw new AppError(400, `Field '${field.name}' must be an array of tags`);
        }
        return actualValue;

      case 'Attachment':
        if (!actualValue || typeof actualValue !== 'object') {
          throw new AppError(400, `Field '${field.name}' must be a valid file upload`);
        }
        if (!actualValue.fileName || !actualValue.filePath) {
          throw new AppError(400, `Field '${field.name}' is missing required file information`);
        }
        return actualValue;

      default:
        return actualValue;
    }
  }

  static async getRecordById(id: string) {
    
    // const versions = await RecordOtherVersion.findAll({
    //   where: { originalRecordId : id },
    //   order: [['version', 'ASC']],
    // });

    // if (versions && versions.length > 0) {
    //   // Versiyalar varsa, sonuncusunu plain obyektə çeviririk
    //   const latestVersion = versions[versions.length - 1].get({ plain: true });
      
    //   // customFields-i işləyirik (əgər lazımdır)
    //   if (latestVersion.customFields) {
    //     for (const fieldId in latestVersion.customFields) {
    //       const field = latestVersion.customFields[fieldId];
    //       if (field.type === 'Attachment' && field.value) {
    //         field.value = {
    //           fileName: field.value.fileName || field.fileName,
    //           filePath: field.value.filePath || field.filePath,
    //           fileSize: field.value.fileSize || field.fileSize,
    //           fileType: field.value.fileType || field.fileType,
    //           fileHash: field.value.fileHash || field.fileHash,
    //         };
    //       }
    //     }
    //   }
    //   return latestVersion;
    // } else {
      
    const record = await Record.findByPk(id, {
      include: [
        {
          model: Cabinet,
          as: 'cabinet'
        },
        {
          model: User,
          as: 'creator',
          attributes: ['id', 'firstName', 'lastName', 'avatar']
        },
        {
          model: RecordNoteComment,
          as: 'notes',
          where: { type: 'note' },
          required: false,
          include: [{
            model: User,
            as: 'creator',
            attributes: ['id', 'firstName', 'lastName', 'avatar']
          }],
          order: [['createdAt', 'DESC']],
          limit: 1 // Get only the latest note
        },
        {
          model: RecordNoteComment,
          as: 'comments',
          where: { type: 'comment' },
          required: false,
          include: [{
            model: User,
            as: 'creator',
            attributes: ['id', 'firstName', 'lastName', 'avatar']
          }],
          order: [['createdAt', 'DESC']]
        }
      ],
      attributes: {
        include: [
          'id', 'title', 'description', 'cabinetId', 'creatorId',
          'filePath', 'fileName', 'fileSize', 'fileType', 'fileHash',
          'version', 'status', 'metadata', 'customFields', 'tags',
          'isTemplate', 'isActive', 'lastModifiedBy', 'createdAt', 'updatedAt'
        ]
      }
    });

    if (!record) {
      throw new AppError(400,'Record not found');
    }

    // Process customFields to ensure file information is properly structured
    if (record.customFields) {
      for (const fieldId in record.customFields) {
        const field = record.customFields[fieldId];
        if (field.type === 'Attachment' && field.value) {
          // Ensure file information is properly structured in customFields
          field.value = {
            fileName: field.value.fileName || field.fileName,
            filePath: field.value.filePath || field.filePath,
            fileSize: field.value.fileSize || field.fileSize,
            fileType: field.value.fileType || field.fileType,
            fileHash: field.value.fileHash || field.fileHash
          };
        }
      }
    }

    return record;

  //}

  }

  static async getOtherRecordsByOriginalId(originalRecordId: string) {
    const versions = await RecordOtherVersion.findAll({
      where: { originalRecordId },
      order: [['version', 'ASC']],
    });

    if (!versions || versions.length === 0) {
      throw new AppError(404, 'No versions found for this record');
    }


    versions.forEach((version) => {
      if (version.customFields) {
        for (const fieldId in version.customFields) {
          const field = version.customFields[fieldId];
          if (field.type === 'Attachment' && field.value) {
            field.value = {
              fileName: field.value.fileName || field.fileName,
              filePath: field.value.filePath || field.filePath,
              fileSize: field.value.fileSize || field.fileSize,
              fileType: field.value.fileType || field.fileType,
              fileHash: field.value.fileHash || field.fileHash,
            };
          }
        }
      }
    });

    return versions;
  }

  static async deleteRecord(id: string, userId: string) {
    const record = await Record.findByPk(id, {
      include: [
        {
          model: RecordVersion,
          as: 'versions'
        },
        {
          model: Cabinet,
          as: 'cabinet',
          required: true
        }
      ]
    });
    
    if (!record) {
      throw new AppError(404, 'Record not found');
    }

    if (!record.cabinet) {
      throw new AppError(404, 'Cabinet not found');
    }

    // Check if user has permission (creator, cabinet owner, approver, or member_full)
    const isCreator = record.creatorId === userId;
    const isCabinetOwner = record.cabinet.createdById === userId;
    const isApprover = record.cabinet.approvers?.some(
      (approver: CabinetApprover) => approver.userId === userId
    );

    // Check if user is a member_full
    const member = await CabinetMember.findOne({
      where: { 
        cabinetId: record.cabinet.id,
        userId: userId,
        role: 'member_full'
      }
    });

    const isMemberFull = !!member;

    if (!isCreator && !isCabinetOwner && !isApprover && !isMemberFull) {
      throw new AppError(403, 'You do not have permission to delete this record');
    }

    // Start a transaction to ensure all deletions are atomic
    const transaction = await sequelize.transaction();

    try {
      // Delete all versions first
      await RecordVersion.destroy({
        where: { recordId: id },
        transaction
      });

      // Then delete the record
      await record.destroy({ transaction });

      // If all operations are successful, commit the transaction
      await transaction.commit();

      return true;
    } catch (error) {
      // If any operation fails, rollback the transaction
      await transaction.rollback();
      throw error;
    }
  }

  static async getRecordsByStatus(status: string | string[], creatorId?: string) {
    const whereClause: any = {
      status: Array.isArray(status) ? { [Op.in]: status } : status
    };
    
    if (creatorId) {
      whereClause[Op.or] = [
        { creatorId },
        sequelize.literal(`"cabinet"."approvers" @> '[{"userId": "${creatorId}"}]'`),
        // Add check for cabinet_members with role 'member_full'
        sequelize.literal(`EXISTS (
          SELECT 1 FROM cabinet_members cm 
          WHERE cm.cabinet_id = "cabinet"."id" 
          AND cm.user_id = '${creatorId}'
          AND cm.role = 'member_full'
        )`)
      ];
    }

    return Record.findAll({
      where: whereClause,
      include: [
        {
          model: Cabinet,
          as: 'cabinet',
          attributes: ['id', 'name', 'description']
        },
        {
          model: User,
          as: 'creator',
          attributes: ['id', 'firstName', 'lastName', 'email']
        }
      ],
      order: [['createdAt', 'DESC']]
    });
  }

  static async createNewVersion(recordId: string, versionData: {
    fileName: string;
    fileSize: number;
    fileType: string;
    filePath: string;
    fileHash: string;
    uploadedBy: string;
    note?: string;
  }) {
    const record = await Record.findByPk(recordId);
    if (!record) {
      throw new AppError(404, 'Record not found');
    }

    // Get the current version number and increment it
    const latestVersion = await RecordVersion.findOne({
      where: { recordId },
      order: [['version', 'DESC']],
    });

    const newVersionNumber = latestVersion ? latestVersion.version + 1 : 1;

    // Create new version
    const version = await RecordVersion.create({
      recordId,
      version: newVersionNumber,
      ...versionData,
    });

    // Update the record with the latest file info
    await record.update({
      filePath: versionData.filePath,
      fileName: versionData.fileName,
      fileSize: versionData.fileSize,
      fileType: versionData.fileType,
      fileHash: versionData.fileHash,
      version: newVersionNumber,
      lastModifiedBy: versionData.uploadedBy,
    });

    return version;
  }

  static async getRecordVersions(recordId: string) {
    const record = await Record.findByPk(recordId);
    if (!record) {
      throw new AppError(404, 'Record not found');
    }

    const versions = await RecordVersion.findAll({
      where: { recordId },
      order: [['version', 'DESC']],
      include: [
        {
          model: Record,
          as: 'record',
          attributes: ['title'],
        },
      ],
    });

    return versions;
  }

  static async deleteVersion(recordId: string, versionId: string, userId: string) {
    const record = await Record.findByPk(recordId);
    if (!record) {
      throw new AppError(404, 'Record not found');
    }

    // Check if user has permission (creator or cabinet owner)
    const cabinet = await Cabinet.findByPk(record.cabinetId);
    if (!cabinet) {
      throw new AppError(404, 'Cabinet not found');
    }

    if (record.creatorId !== userId && cabinet.createdById !== userId) {
      throw new AppError(403, 'You do not have permission to delete this version');
    }

    const version = await RecordVersion.findOne({
      where: { id: versionId, recordId }
    });

    if (!version) {
      throw new AppError(404, 'Version not found');
    }

    // Don't allow deletion of the only version
    const versionsCount = await RecordVersion.count({ where: { recordId } });
    if (versionsCount === 1) {
      throw new AppError(400, 'Cannot delete the only version of the record');
    }

    // If deleting the latest version, update record to point to the previous version
    if (version.version === record.version) {
      const previousVersion = await RecordVersion.findOne({
        where: { recordId, version: { [Op.lt]: version.version } },
        order: [['version', 'DESC']],
      });

      if (previousVersion) {
        await record.update({
          filePath: previousVersion.filePath,
          fileName: previousVersion.fileName,
          fileSize: previousVersion.fileSize,
          fileType: previousVersion.fileType,
          fileHash: previousVersion.fileHash,
          version: previousVersion.version,
          lastModifiedBy: userId,
        });
      }
    }

    // Delete the version
    await version.destroy();

    return true;
  }


  static async updateRecord(
    id: string,
    data: Partial<Record> & { note?: string; comments?: string },
    userId: string
  ) {
    const transaction = await sequelize.transaction();
  
    try {
      // Mövcud recordu tapırıq
      const record = await Record.findByPk(id);
      if (!record) {
        throw new AppError(404, 'Record not found');
      }
  
      // Recordu update edirik
      await record.update(
        {
          ...data,
          lastModifiedBy: userId,
        },
        { transaction }
      );
  
      // Əgər comment varsa, comment əlavə edirik
      if (data.comments) {
        await RecordNoteComment.create(
          {
            recordId: id,
            content: data.comments,
            type: 'comment',
            createdBy: userId,
          },
          { transaction }
        );
      }
  
      // Transactionu commit edirik
      await transaction.commit();
  
      // Activity log əməliyyatını həyata keçiririk
      await ActivityService.logActivity({
        userId,
        action: ActivityType.UPDATE,
        resourceType: ResourceType.RECORD,
        resourceId: id,
        resourceName: record.title,
        details: data.note || 'Record updated',
      });
  
      // Kabinetin approverlərinə bildiriş göndəririk
      const cabinet = await Cabinet.findByPk(record.cabinetId);
      // if (cabinet && cabinet.approvers && cabinet.approvers.length > 0) {
      //   await Promise.all(
      //     cabinet.approvers.map((approver: { userId: string }) =>
      //       NotificationService.createNotification({
      //         userId: approver.userId,
      //         title: 'Record Updated',
      //         message: `Record "${record.title}" has been updated.`,
      //         type: 'record_update',
      //         entityType: 'record',
      //         entityId: record.id,
      //       })
      //     )
      //   );
      // }

      if(cabinet){
        await NotificationService.createNotification({
          userId: cabinet.createdById,
          title: 'Record Updated',
          message: `Record "${record.title}" has been updated.`,
          type: 'record_update',
          entityType: 'record',
          entityId: record.id
        });
      }
  
      // Yenilənmiş recordu, note və comment-ləri ilə birlikdə əldə edirik
      const updatedRecord = await Record.findByPk(id, {
        include: [
          {
            model: Cabinet,
            as: 'cabinet',
          },
          {
            model: User,
            as: 'creator',
          },
          {
            model: RecordNoteComment,
            as: 'notes',
            where: { type: 'note' },
            required: false,
            include: [
              {
                model: User,
                as: 'creator',
                attributes: ['id', 'firstName', 'lastName', 'avatar'],
              },
            ],
            order: [['createdAt', 'DESC']],
          },
          {
            model: RecordNoteComment,
            as: 'comments',
            where: { type: 'comment' },
            required: false,
            include: [
              {
                model: User,
                as: 'creator',
                attributes: ['id', 'firstName', 'lastName', 'avatar'],
              },
            ],
            order: [['createdAt', 'DESC']],
          },
        ],
        attributes: {
          include: [
            'id',
            'title',
            'description',
            'cabinetId',
            'creatorId',
            'filePath',
            'fileName',
            'fileSize',
            'fileType',
            'fileHash',
            'version',
            'status',
            'metadata',
            'customFields',
            'tags',
            'isTemplate',
            'isActive',
            'lastModifiedBy',
            'createdAt',
            'updatedAt',
          ],
        },
      });
  
      if (!updatedRecord) {
        throw new AppError(404, 'Updated record not found');
      }
  
      // customFields məlumatının strukturunu təmin edirik (əgər varsa)
      if (updatedRecord.customFields) {
        for (const fieldId in updatedRecord.customFields) {
          const field = updatedRecord.customFields[fieldId];
          if (field.type === 'Attachment' && field.value) {
            field.value = {
              fileName: field.value.fileName || field.fileName,
              filePath: field.value.filePath || field.filePath,
              fileSize: field.value.fileSize || field.fileSize,
              fileType: field.value.fileType || field.fileType,
              fileHash: field.value.fileHash || field.fileHash,
            };
          }
        }
      }
  
      return updatedRecord;
    } catch (error) {
      try {
        // Əgər error varsa, transactionu rollback edirik
        await transaction.rollback();
      } catch (rollbackError) {
        console.error('Rollback failed:', rollbackError);
      }
      throw error;
    }
  }


  static async modifyRecord(data: ModifyRecordData) {
    // Əvvəlcə mövcud recordu tapırıq
    const originalRecord = await Record.findByPk(data.recordId);
    if (!originalRecord) {
      throw new AppError(404, 'Record not found');
    }

    // Kabinet və yaradan istifadəçini yoxlayırıq
    const cabinet = await Cabinet.findByPk(data.cabinetId);
    if (!cabinet) {
      throw new AppError(400, 'Cabinet not found');
    }
    const creator = await User.findByPk(data.creatorId);
    if (!creator) {
      throw new AppError(400, 'Creator not found');
    }

    // Custom field-ləri kabinetin konfiqurasiyası ilə yoxlaya bilərik (əvvəlki nümunəyə bənzər)
    const validatedFields = await RecordService.validateCustomFields(
      data.customFields,
      cabinet.customFields
    );

    // Mövcud record üçün son versiyanı tapırıq
    const latestVersion = await RecordOtherVersion.findOne({
      where: { originalRecordId: data.recordId },
      order: [['version', 'DESC']],
    });
    const newVersion = latestVersion ? latestVersion.version + 1 : 2;

    // PDF faylı varsa, onu işləyirik
    let pdfFileInfo = null;
    if (data.pdfFile) {
      try {
        let pdfData;
        try {
          pdfData = await extractPdfContent(data.pdfFile);
        } catch (pdfError) {
          console.error('PDF processing error (non-fatal):', pdfError);
          pdfData = {
            extractedText: 'PDF text extraction failed',
            extractedFields: [
              { name: 'Document Name', value: data.pdfFile.originalname },
              { name: 'File Size', value: `${Math.round(data.pdfFile.size / 1024)} KB` },
            ],
            pageCount: 1,
          };
        }

        const timestamp = Date.now();
        const pdfFileName = `${timestamp}-${data.pdfFile.originalname.replace(/\s+/g, '_')}`;
        const pdfFilePath = path.join(UPLOAD_DIR, pdfFileName);

        if (!fs.existsSync(UPLOAD_DIR)) {
          fs.mkdirSync(UPLOAD_DIR, { recursive: true });
        }

        await writeFileAsync(pdfFilePath, data.pdfFile.buffer);
        pdfFileInfo = {
          fileName: data.pdfFile.originalname,
          filePath: pdfFilePath,
          fileSize: data.pdfFile.size,
          fileType: data.pdfFile.mimetype,
          fileHash: 'N/A', // Əgər lazımdırsa, hash hesablanmalıdır
          pageCount: pdfData.pageCount,
        };
      } catch (err) {
        console.error('Failed to process PDF file', err);
      }
    }

    // Transaction daxilində yeni versiyanı yaradırıq
    const transaction = await sequelize.transaction();
    try {
      const newRecordVersion = await RecordOtherVersion.create(
        {
          originalRecordId: data.recordId,
          title: data.title.trim(),
          description: originalRecord.description,
          cabinetId: data.cabinetId,
          creatorId: data.creatorId,
          customFields: validatedFields,
          status: data.status as RecordStatus,
          tags: data.tags,
          isTemplate: originalRecord.isTemplate,
          isActive: originalRecord.isActive,
          lastModifiedBy: data.creatorId,
          version: newVersion,
          ...(pdfFileInfo && {
            fileName: pdfFileInfo.fileName,
            filePath: pdfFileInfo.filePath,
            fileSize: pdfFileInfo.fileSize,
            fileType: pdfFileInfo.fileType,
            fileHash: pdfFileInfo.fileHash,
          }),
        },
        { transaction }
      );
      await transaction.commit();

      await ActivityService.logActivity({
        userId : data.creatorId,
        action: ActivityType.UPDATE,
        resourceType: ResourceType.RECORD,
        resourceId: data.recordId,
        resourceName: data.title,
        details: 'Record modified',
      });

      // Notification göndərilir (məsələn, kabinetin yaradan istifadəçiyə)
      await NotificationService.createNotification({
        userId: cabinet.createdById,
        title: 'Record Modified',
        message: `Record "${data.title}" has been modified. New version: ${newVersion}`,
        type: 'record_update',
        entityType: 'record',
        entityId: data.recordId,
      });

      // await transaction.commit();
      return newRecordVersion;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
  
  static async approveRecord(recordId: string, userId: string, note?: string, data?: Partial<Record>) {
    const transaction = await sequelize.transaction();
    try {
      const record = await Record.findByPk(recordId);
      if (!record) {
        throw new AppError(404, 'Record not found');
      }
      // Redaktə olunmuş məlumatlar daxil olmaqla update edilir
      await record.update({
        ...data,
        status: RecordStatus.APPROVED,
        lastModifiedBy: userId,
      }, { transaction });
      
      await RecordNoteComment.create({
        recordId,
        content: note || 'Record approved',
        type: 'system',
        action: 'approve',
        createdBy: userId
      }, { transaction });
      
      await transaction.commit();
  
      // Commitdən sonra Notification və activity log əməliyyatları
      await ActivityService.logActivity({
        userId,
        action: ActivityType.APPROVE,
        resourceType: ResourceType.RECORD,
        resourceId: recordId,
        resourceName: record.title,
        details: 'Record approved'
      });
      if (NotificationService.createRecordApprovalNotification) {
        await NotificationService.createRecordApprovalNotification(record.creatorId, recordId, record.title);
      }
  
      const updatedRecord = await Record.findByPk(recordId, {
        include: [
          {
            model: RecordNoteComment,
            as: 'notes',
            where: { type: 'note' },
            required: false,
            include: [{
              model: User,
              as: 'creator',
              attributes: ['id', 'firstName', 'lastName']
            }]
          },
          {
            model: RecordNoteComment,
            as: 'comments',
            where: { type: 'comment' },
            required: false,
            include: [{
              model: User,
              as: 'creator',
              attributes: ['id', 'firstName', 'lastName']
            }]
          }
        ]
      });
      return updatedRecord;
    } catch (error) {
      
        try {
          await transaction.rollback();
        } catch (rollbackError) {
          console.error('Rollback failed:', rollbackError);
        }
      throw error;
    }
  }
  
  static async rejectRecord(recordId: string, userId: string, note?: string, comments?: string, data?: Partial<Record>) {
    const transaction = await sequelize.transaction();
    try {
      const record = await Record.findByPk(recordId, {
        include: [{ model: Cabinet, as: 'cabinet' }],
        transaction
      });
      if (!record || !record.cabinet) {
        throw new AppError(404, 'Record or cabinet not found');
      }
      const cabinet = await Cabinet.findByPk(record.cabinetId, { transaction });
      if (!cabinet) {
        throw new AppError(404, 'Cabinet not found');
      }
      const isApprover = cabinet.approvers?.some(approver => approver.userId === userId) ?? false;
      if (!isApprover) {
        const cabinetMember = await CabinetMember.findOne({
          where: { cabinetId: record.cabinetId, userId: userId, role: 'member_full' },
          transaction
        });
        if (!cabinetMember) {
          throw new AppError(403, 'User is not authorized to reject this record');
        }
      }
      if (record.status !== RecordStatus.PENDING) {
        throw new AppError(400, 'Only pending records can be rejected');
      }

      console.log('Rejecting record data:', data, 'by user:', userId);
      
      await record.update({
        ...data,
        status: RecordStatus.REJECTED,
        lastModifiedBy: userId
      }, { transaction });
      // if (note) {
      //   await RecordNoteComment.create({
      //     recordId,
      //     content: note,
      //     type: 'note',
      //     action: 'reject',
      //     createdBy: userId
      //   }, { transaction });
      // }
      if (comments) {
        await RecordNoteComment.create({
          recordId,
          content: comments,
          type: 'comment',
          action: 'reject',
          createdBy: userId
        }, { transaction });
      }
      await transaction.commit();
    
    
      await ActivityService.logActivity({
        userId,
        action: ActivityType.REJECT,
        resourceType: ResourceType.RECORD,
        resourceId: recordId,
        resourceName: record.title,
        details: note || 'Record rejected'
      });
      if (NotificationService.createRecordRejectionNotification) {
        await NotificationService.createRecordRejectionNotification(record.creatorId, recordId, record.title, note || '');
      }
    
      const updatedRecord = await Record.findByPk(recordId, {
        include: [
          {
            model: User,
            as: 'creator',
            attributes: ['id', 'firstName', 'lastName']
          },
          {
            model: Cabinet,
            as: 'cabinet'
          },
          {
            model: RecordNoteComment,
            as: 'notes',
            where: { type: 'note' },
            required: false,
            include: [{
              model: User,
              as: 'creator',
              attributes: ['id', 'firstName', 'lastName']
            }],
            order: [['createdAt', 'DESC']]
          },
          {
            model: RecordNoteComment,
            as: 'comments',
            where: { type: 'comment' },
            required: false,
            include: [{
              model: User,
              as: 'creator',
              attributes: ['id', 'firstName', 'lastName']
            }],
            order: [['createdAt', 'DESC']]
          }
        ]
      });
      return updatedRecord;
    } catch (error) {
      
        try {
          await transaction.rollback();
        } catch (rollbackError) {
          console.error('Rollback failed:', rollbackError);
        }
      
      throw error;
    }
  }
  
  

  static async getCabinetRecords(cabinetId: string, page = 1, limit = 10) {
    try {
      const offset = (page - 1) * limit;

      const { rows: records, count } = await Record.findAndCountAll({
        where: {
          cabinetId,
          isActive: true,
          [Op.or]: [
            { deletedAt: null },
            { deletedAt: { [Op.gt]: new Date() } }
          ]
        },
        include: [
          {
            model: User,
            as: 'creator',
            attributes: ['id', 'firstName', 'lastName', 'avatar']
          },
          {
            model: Cabinet,
            as: 'cabinet',
            attributes: ['id', 'name']
          },
          {
            model: RecordNoteComment,
            as: 'notes',
            where: { type: 'note' },
            required: false,
            limit: 1,
            order: [['createdAt', 'DESC']],
            include: [{
              model: User,
              as: 'creator',
              attributes: ['id', 'firstName', 'lastName']
            }]
          }
        ],
        order: [['createdAt', 'DESC']],
        limit,
        offset,
        distinct: true
      });

      // Transform records to match frontend interface
      const transformedRecords = records.map(record => {
        const creator = record.get('creator') as User;
        const cabinet = record.get('cabinet') as Cabinet;
        const notes = record.get('notes') as RecordNoteComment[];

        return {
          id: record.id,
          key: record.id,
          recordName: record.title,
          status: record.status,
          createdBy: {
            id: creator.id,
            firstName: creator.firstName,
            lastName: creator.lastName,
            avatar: creator.avatar
          },
          createdAt: record.createdAt,
          priority: (record.metadata as any)?.priority || 'Medium',
          cabinet: {
            id: cabinet.id,
            name: cabinet.name
          },
          latestNote: notes?.[0] || null
        };
      });

      return {
        records: transformedRecords,
        total: count,
        page,
        limit,
        totalPages: Math.ceil(count / limit)
      };
    } catch (err) {
      console.error('Error in getCabinetRecords:', err);
      const error = err as Error;
      throw new AppError(error instanceof AppError ? error.statusCode : 500, error.message);
    }
  }

  async getRecord(id: string) {
    return await Record.findOne({
      where: {
        id,
        isActive: true
      },
      include: [
        {
          model: User,
          as: 'creator',
          attributes: ['id', 'firstName', 'lastName', 'avatar']
        },
        {
          model: Cabinet,
          as: 'cabinet'
        }
      ]
    });
  }

  static async getMyRecordsByStatus(status: string | string[], userId: string) {
    
    const whereClause: any = {
      status: Array.isArray(status) ? { [Op.in]: status } : status,
      creatorId: userId
    };
    
    return Record.findAll({
      where: whereClause,
      include: [
        {
          model: Cabinet,
          as: 'cabinet',
          attributes: ['id', 'name', 'description']
        },
        {
          model: User,
          as: 'creator',
          attributes: ['id', 'firstName', 'lastName', 'email', 'avatar']
        }
      ],
      order: [['createdAt', 'DESC']]
    });
  }

  static async getRecordsWaitingForMyApproval(userId: string) {
    console.log('Fetching records waiting for approval for user:', userId);
    const getRecord = await Record.findAll({
      where: {
        status: RecordStatus.PENDING
      },
      include: [
        {
          model: Cabinet,
          as: 'cabinet',
          attributes: ['id', 'name', 'description', 'approvers','createdById'],
          required: true,
          where: {
            createdById: userId,
          }
        },
        {
          model: User,
          as: 'creator',
          attributes: ['id', 'firstName', 'lastName', 'email', 'avatar']
        }
      ],
      order: [['createdAt', 'DESC']]
    });
    console.log('Records fetched:', getRecord);

    return getRecord
  }

  
  static async associateFilesWithRecord(recordId: string, fileIds: string[]) {
    try {
      // Validate that the record exists
      const record = await Record.findByPk(recordId);
      if (!record) {
        throw new AppError(404, 'Record not found');
      }

      // Associate files with the record and mark them as allocated
      return await fileService.associateFilesWithRecord(fileIds, recordId);
    } catch (error) {
      console.error('Error associating files with record:', error);
      throw error;
    }
  }

  // Modified createRecord to support multiple file IDs
  static async createRecordWithFiles(data: {
    title: string;
    cabinetId: string;
    creatorId: string;
    customFields: { [key: string]: any };
    status: RecordStatus;
    isTemplate: boolean;
    isActive: boolean;
    tags: string[];
    fileIds?: string[];
  }) {
    // Validate title
    if (!data.title || !data.title.trim()) {
      throw new AppError(400, 'Record title is required');
    }
    
    // Validate cabinet exists and get its custom fields configuration
    const cabinet = await Cabinet.findByPk(data.cabinetId);
    if (!cabinet) {
      throw new AppError(400, 'Cabinet not found');
    }
    
    // Validate creator exists
    const creator = await User.findByPk(data.creatorId);
    if (!creator) {
      throw new AppError(400, 'Creator not found');
    }
    
    // Validate custom fields against cabinet configuration
    const validatedFields = await RecordService.validateCustomFields(data.customFields, cabinet.customFields);
    
    // Find the first attachment field if any
    let fileInfo = null;
    for (const fieldId in validatedFields) {
      const field = validatedFields[fieldId];
      if (field.type === 'Attachment' && field.value) {
        fileInfo = field.value;
        break;
      }
    }
    
    // Start a transaction for the record creation
    const transaction = await sequelize.transaction();
    try {
      // Create record with validated fields and file information
      const record = await Record.create({
        ...data,
        title: data.title.trim(),
        customFields: validatedFields,
        lastModifiedBy: data.creatorId,
        version: 1,
        // Add file information if present
        ...(fileInfo && {
          fileName: fileInfo.fileName,
          filePath: fileInfo.filePath,
          fileSize: fileInfo.fileSize,
          fileType: fileInfo.fileType,
          fileHash: fileInfo.fileHash,
        })
      }, { transaction });
      
      // Associate files if provided
      if (data.fileIds && data.fileIds.length > 0) {
        // Create associations between the record and the files
        const recordFiles = data.fileIds.map(fileId => ({
          id: sequelize.literal('uuid_generate_v4()'),
          recordId: record.id,
          fileId: fileId
        }));
        
        await sequelize.models.RecordFile.bulkCreate(recordFiles, { transaction });
        
        // Mark files as allocated
        await sequelize.models.File.update(
          { isAllocated: true },
          { 
            where: { id: data.fileIds },
            transaction 
          }
        );
      }
      
      // Commit the transaction
      await transaction.commit();
      return record;
    } catch (error) {
      // Rollback transaction in case of error
      await transaction.rollback();
      throw error;
    }
  }
}