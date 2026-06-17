const pdfParse  = require('pdf-parse')
const mammoth   = require('mammoth')
const officeParser = require('officeparser')
const path      = require('path')

/**
 * Extract plain text from uploaded file buffer
 * Supports: PDF, DOCX, PPTX, TXT
 */
async function extractText(buffer, originalname) {
  const ext = path.extname(originalname).toLowerCase()

  switch (ext) {

    case '.pdf': {
      const data = await pdfParse(buffer)
      const text = data.text?.trim()
      if (!text || text.length < 20) throw new Error('Could not extract text from this PDF. Try pasting the text directly.')
      return { text: text.slice(0, 12000), pages: data.numpages, type: 'PDF' }
    }

    case '.docx': {
      const result = await mammoth.extractRawText({ buffer })
      const text   = result.value?.trim()
      if (!text || text.length < 20) throw new Error('Could not extract text from this Word document.')
      return { text: text.slice(0, 12000), pages: null, type: 'Word Document' }
    }

    case '.pptx': {
      const text = await new Promise((resolve, reject) => {
        officeParser.parseOfficeAsync(buffer, { outputErrorToConsole: false })
          .then(data => resolve(data?.trim() || ''))
          .catch(reject)
      })
      if (!text || text.length < 20) throw new Error('Could not extract text from this PowerPoint.')
      return { text: text.slice(0, 12000), pages: null, type: 'PowerPoint' }
    }

    case '.txt': {
      const text = buffer.toString('utf-8').trim()
      if (!text || text.length < 10) throw new Error('This text file appears to be empty.')
      return { text: text.slice(0, 12000), pages: null, type: 'Text File' }
    }

    default:
      throw new Error(`Unsupported file type: ${ext}. Please upload PDF, DOCX, PPTX, or TXT.`)
  }
}

module.exports = { extractText }
