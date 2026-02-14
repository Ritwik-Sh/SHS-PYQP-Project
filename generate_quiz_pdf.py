#!/usr/bin/env python3
"""
Quiz PDF Generator for SHS-PYQP-Project
Generates printable quiz PDFs with questions and answer key
"""

import json
import sys
import os
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle, Frame, PageTemplate
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# Color scheme
COLOR_BG = colors.HexColor('#fdfcfa')
COLOR_TEXT = colors.HexColor('#1a1614')
COLOR_TEXT_SECONDARY = colors.HexColor('#6b6561')
COLOR_ACCENT = colors.HexColor('#d97706')
COLOR_BORDER = colors.HexColor('#e7e5e4')
COLOR_CODE_BG = colors.HexColor('#faf8f6')
COLOR_ANSWER_BG = colors.HexColor('#fef3c7')

class FooterCanvas:
    """Custom canvas for adding headers and footers to each page"""
    
    def __init__(self, topic):
        self.topic = topic.replace('-', ' ').title()
        self.pages = []
    
    def add_page_info(self, canvas, doc):
        """Add footer information to each page"""
        canvas.saveState()
        
        # Footer line
        canvas.setStrokeColor(COLOR_BORDER)
        canvas.setLineWidth(0.5)
        canvas.line(0.75*inch, 0.5*inch, letter[0] - 0.75*inch, 0.5*inch)
        
        # Left footer - Project name
        canvas.setFont('Helvetica', 8)
        canvas.setFillColor(COLOR_TEXT_SECONDARY)
        canvas.drawString(0.75*inch, 0.35*inch, "SHS-PYQP-Project Resources")
        
        # Center footer - URL
        canvas.drawCentredString(letter[0] / 2, 0.35*inch, "https://shs-pyqp-project.vercel.app")
        
        # Right footer - Topic
        canvas.drawRightString(letter[0] - 0.75*inch, 0.35*inch, self.topic)
        
        # Page number (bottom right, above footer line)
        page_num = canvas.getPageNumber()
        canvas.setFont('Helvetica', 9)
        canvas.setFillColor(COLOR_TEXT)
        canvas.drawRightString(letter[0] - 0.75*inch, 0.6*inch, f"Page {page_num}")
        
        canvas.restoreState()

def register_custom_font(font_path):
    """Register JetBrains Mono font if available"""
    try:
        if os.path.exists(font_path):
            pdfmetrics.registerFont(TTFont('JetBrainsMono', font_path))
            return True
    except Exception as e:
        print(f"Warning: Could not load custom font: {e}", file=sys.stderr)
    return False

def clean_text(text):
    """Clean and format text for PDF"""
    if not text:
        return ""
    
    # Replace code blocks
    text = str(text)
    
    # Handle code blocks
    if '```java' in text or '```' in text:
        # For code blocks, we'll handle them specially
        return text
    
    # Clean up common formatting
    text = text.replace('\\n', '<br/>')
    text = text.replace('\n', '<br/>')
    text = text.replace('\t', '&nbsp;&nbsp;&nbsp;&nbsp;')
    
    return text.strip()

def format_code_block(code_text, has_custom_font=False):
    """Format code with proper styling"""
    if not code_text:
        return ""
    
    # Remove code markers
    code_text = code_text.replace('```java', '').replace('```', '').strip()
    
    # Escape XML special characters
    code_text = code_text.replace('&', '&amp;')
    code_text = code_text.replace('<', '&lt;')
    code_text = code_text.replace('>', '&gt;')
    
    # Replace newlines and tabs
    code_text = code_text.replace('\n', '<br/>')
    code_text = code_text.replace('\t', '&nbsp;&nbsp;&nbsp;&nbsp;')
    
    font_face = 'JetBrainsMono' if has_custom_font else 'Courier'
    
    return f'<font face="{font_face}" size="8" color="#1a1614">{code_text}</font>'

def extract_code_blocks(text):
    """Extract and separate code blocks from text"""
    parts = []
    current_pos = 0
    
    while '```' in text[current_pos:]:
        # Find start of code block
        start = text.find('```', current_pos)
        if start == -1:
            break
        
        # Add text before code block
        if start > current_pos:
            parts.append(('text', text[current_pos:start]))
        
        # Find end of code block
        end = text.find('```', start + 3)
        if end == -1:
            # Unclosed code block, treat rest as code
            parts.append(('code', text[start:]))
            break
        
        # Add code block
        code = text[start:end+3]
        parts.append(('code', code))
        current_pos = end + 3
    
    # Add remaining text
    if current_pos < len(text):
        parts.append(('text', text[current_pos:]))
    
    return parts if parts else [('text', text)]

def generate_quiz_pdf(quiz_data, topic, output_path, font_path=None):
    """Generate a PDF from quiz data"""
    
    # Register custom font
    has_custom_font = False
    if font_path:
        has_custom_font = register_custom_font(font_path)
    
    # Create PDF
    doc = SimpleDocTemplate(
        output_path,
        pagesize=letter,
        topMargin=0.75*inch,
        bottomMargin=0.75*inch,
        leftMargin=0.75*inch,
        rightMargin=0.75*inch
    )
    
    # Create footer handler
    footer = FooterCanvas(topic)
    
    # Styles
    styles = getSampleStyleSheet()
    
    title_style = ParagraphStyle(
        'CustomTitle',
        parent=styles['Heading1'],
        fontSize=24,
        textColor=COLOR_TEXT,
        spaceAfter=12,
        alignment=TA_CENTER,
        fontName='Helvetica-Bold'
    )
    
    subtitle_style = ParagraphStyle(
        'CustomSubtitle',
        parent=styles['Normal'],
        fontSize=11,
        textColor=COLOR_TEXT_SECONDARY,
        spaceAfter=8,
        alignment=TA_CENTER
    )
    
    section_style = ParagraphStyle(
        'SectionTitle',
        parent=styles['Heading1'],
        fontSize=18,
        textColor=COLOR_ACCENT,
        spaceAfter=20,
        spaceBefore=10,
        alignment=TA_CENTER,
        fontName='Helvetica-Bold'
    )
    
    question_style = ParagraphStyle(
        'Question',
        parent=styles['Normal'],
        fontSize=10,
        textColor=COLOR_TEXT,
        spaceBefore=12,
        spaceAfter=8,
        leading=14
    )
    
    option_style = ParagraphStyle(
        'Option',
        parent=styles['Normal'],
        fontSize=9,
        textColor=COLOR_TEXT,
        leftIndent=24,
        spaceAfter=4,
        leading=13
    )
    
    code_style = ParagraphStyle(
        'Code',
        parent=styles['Normal'],
        fontSize=8,
        fontName='JetBrainsMono' if has_custom_font else 'Courier',
        textColor=COLOR_TEXT,
        backColor=COLOR_CODE_BG,
        leftIndent=16,
        rightIndent=16,
        spaceBefore=8,
        spaceAfter=8,
        leading=12,
        borderPadding=12,
        borderWidth=1,
        borderColor=COLOR_BORDER,
        borderRadius=6
    )
    
    passage_style = ParagraphStyle(
        'Passage',
        parent=styles['Normal'],
        fontSize=9,
        textColor=COLOR_TEXT,
        leftIndent=16,
        rightIndent=16,
        spaceBefore=8,
        spaceAfter=8,
        leading=16,
        backColor=COLOR_CODE_BG,
        borderPadding=12,
        borderWidth=1,
        borderColor=COLOR_BORDER,
        borderRadius=6
    )
    
    story = []
    
    # Title Page
    story.append(Spacer(1, 1.5*inch))
    topic_display = topic.replace('-', ' ').title()
    story.append(Paragraph(f"{topic_display} Quiz", title_style))
    story.append(Spacer(1, 0.2*inch))
    story.append(Paragraph("SHS-PYQP-Project", subtitle_style))
    story.append(Spacer(1, 0.1*inch))
    story.append(Paragraph(f"Total Questions: {len(quiz_data)}", subtitle_style))
    story.append(Spacer(1, 0.2*inch))
    
    # Decorative line
    story.append(Spacer(1, 0.3*inch))
    
    story.append(PageBreak())
    
    # Questions Section
    story.append(Paragraph("QUESTIONS", section_style))
    story.append(Spacer(1, 0.3*inch))
    
    for idx, question in enumerate(quiz_data, 1):
        q_type = question.get('type', 'mcq')
        q_text = question.get('question', '')
        
        # Process question text with code blocks
        parts = extract_code_blocks(q_text)
        
        # Question number and text
        for part_type, part_content in parts:
            if part_type == 'text':
                cleaned = clean_text(part_content)
                if cleaned:
                    if parts.index((part_type, part_content)) == 0:
                        # First part includes question number
                        story.append(Paragraph(f"<b>Q{idx}.</b> {cleaned}", question_style))
                    else:
                        story.append(Paragraph(cleaned, question_style))
            elif part_type == 'code':
                formatted_code = format_code_block(part_content, has_custom_font)
                story.append(Paragraph(formatted_code, code_style))
        
        story.append(Spacer(1, 4))
        
        if q_type == 'mcq' or 'options' in question:
            # Multiple choice options
            options = question.get('options', [])
            for opt_idx, option in enumerate(options):
                letter = chr(65 + opt_idx)  # A, B, C, D
                story.append(Paragraph(f"{letter}) {clean_text(option)}", option_style))
            story.append(Spacer(1, 12))
            
        elif q_type == 'fib':
            # Fill in the blank
            story.append(Paragraph("Answer: _________________________________", option_style))
            story.append(Spacer(1, 12))
            
        elif q_type == 'passageFib':
            # Passage with blanks
            passage = question.get('passage', '')
            
            # Replace blanks with numbered spaces
            blank_num = 0
            while '________' in passage:
                passage = passage.replace('________', f'<b><font color="#d97706">({blank_num})</font></b> <u>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</u>', 1)
                blank_num += 1
            
            # Clean passage text
            passage = clean_text(passage)
            story.append(Paragraph(passage, passage_style))
            story.append(Spacer(1, 12))
    
    # Answer Key Section
    story.append(PageBreak())
    story.append(Paragraph("ANSWER KEY", section_style))
    story.append(Spacer(1, 0.3*inch))
    
    # Build answer data
    answer_data = [['Question', 'Answer']]
    
    for idx, question in enumerate(quiz_data, 1):
        q_type = question.get('type', 'mcq')
        
        if q_type == 'mcq' or 'options' in question:
            answer_idx = question.get('answer', 0)
            options = question.get('options', [])
            if answer_idx < len(options):
                answer_letter = chr(65 + answer_idx)
                answer_text = str(options[answer_idx])[:80]  # Truncate long answers
                answer_data.append([f"Q{idx}", f"{answer_letter}) {answer_text}"])
                
        elif q_type == 'fib':
            answer = question.get('answer', '')
            if isinstance(answer, list):
                answer = ' / '.join(str(a) for a in answer)
            answer_data.append([f"Q{idx}", str(answer)[:100]])
            
        elif q_type == 'passageFib':
            answers = question.get('answer', {})
            answer_parts = []
            for k, v in sorted(answers.items(), key=lambda x: int(x[0]) if str(x[0]).isdigit() else x[0]):
                if isinstance(v, list):
                    v = ' / '.join(str(x) for x in v)
                answer_parts.append(f"({k}) {v}")
            answer_str = ', '.join(answer_parts)
            answer_data.append([f"Q{idx}", answer_str[:120]])
    
    if len(answer_data) > 1:
        # Create answer table
        answer_table = Table(answer_data, colWidths=[0.9*inch, 5.6*inch])
        answer_table.setStyle(TableStyle([
            # Header row
            ('BACKGROUND', (0, 0), (-1, 0), COLOR_ACCENT),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, 0), 10),
            ('ALIGN', (0, 0), (-1, 0), 'CENTER'),
            
            # Data rows
            ('BACKGROUND', (0, 1), (-1, -1), COLOR_ANSWER_BG),
            ('TEXTCOLOR', (0, 1), (-1, -1), COLOR_TEXT),
            ('FONTNAME', (0, 1), (0, -1), 'Helvetica-Bold'),
            ('FONTNAME', (1, 1), (-1, -1), 'Helvetica'),
            ('FONTSIZE', (0, 1), (-1, -1), 9),
            ('ALIGN', (0, 1), (0, -1), 'CENTER'),
            ('ALIGN', (1, 1), (-1, -1), 'LEFT'),
            
            # All cells
            ('TOPPADDING', (0, 0), (-1, -1), 8),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
            ('LEFTPADDING', (0, 0), (-1, -1), 8),
            ('RIGHTPADDING', (0, 0), (-1, -1), 8),
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('GRID', (0, 0), (-1, -1), 0.5, COLOR_BORDER),
            ('ROWBACKGROUNDS', (0, 1), (-1, -1), [COLOR_ANSWER_BG, colors.white])
        ]))
        story.append(answer_table)
    
    # Build PDF with footer
    doc.build(story, onFirstPage=footer.add_page_info, onLaterPages=footer.add_page_info)
    
    return output_path

def main():
    """Main entry point for command line usage"""
    if len(sys.argv) < 4:
        print("Usage: python generate_quiz_pdf.py <quiz_data.json> <topic> <output.pdf> [font_path]")
        sys.exit(1)
    
    quiz_data_path = sys.argv[1]
    topic = sys.argv[2]
    output_path = sys.argv[3]
    font_path = sys.argv[4] if len(sys.argv) > 4 else None
    
    # Read quiz data
    with open(quiz_data_path, 'r', encoding='utf-8') as f:
        quiz_data = json.load(f)
    
    # Generate PDF
    try:
        result = generate_quiz_pdf(quiz_data, topic, output_path, font_path)
        print(f"SUCCESS: {result}")
    except Exception as e:
        print(f"ERROR: {str(e)}", file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()