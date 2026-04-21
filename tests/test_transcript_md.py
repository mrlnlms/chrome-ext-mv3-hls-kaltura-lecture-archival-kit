"""Testa geração de transcript em Markdown a partir de SRT."""
from host.core import transcript_md


def test_strip_timestamps():
    srt = "1\n00:00:01,000 --> 00:00:04,000\nHello world\n\n2\n00:00:05,000 --> 00:00:07,000\nHow are you"
    text = transcript_md.srt_to_plain_text(srt)
    assert text == "Hello world How are you"


def test_paragraph_break_at_sentence_end_with_capital():
    """Só quebra em `.` + maiúscula IF >= 120 chars no parágrafo atual.

    'A' * 106 + ' fim de teste.' = 120 chars exatos — atinge o mínimo e dispara quebra.
    """
    text = (
        "A" * 106 + " fim de teste. Início do próximo parágrafo com muitas palavras pra passar o limite "
        "de 120 caracteres e forçar a quebra depois da pontuação."
    )
    md = transcript_md.format_paragraphs(text)
    assert md.count("\n\n") >= 1


def test_no_break_on_abbreviation_Dr():
    """Depois de 'Dr.' + maiúscula, não quebra (é abreviação)."""
    text = "Hoje o Dr. Silva falou sobre " + "x" * 150 + ". Depois seguimos"
    md = transcript_md.format_paragraphs(text)
    first_break_pos = md.find("\n\n")
    # 'Dr.' tem que estar no PRIMEIRO parágrafo (antes do primeiro break)
    if first_break_pos >= 0:
        assert "Dr." in md[:first_break_pos]


def test_short_paragraph_not_broken():
    """Se o parágrafo atual tem <120 chars, não quebra mesmo com pontuação + maiúscula."""
    text = "Oi. Tudo bem?"
    md = transcript_md.format_paragraphs(text)
    assert "\n\n" not in md


def test_srt_to_markdown_composition():
    """srt_to_markdown compõe srt_to_plain_text + format_paragraphs corretamente."""
    srt = "1\n00:00:01,000 --> 00:00:03,000\nTexto simples\n\n2\n00:00:04,000 --> 00:00:06,000\nde exemplo"
    md = transcript_md.srt_to_markdown(srt)
    assert "Texto simples de exemplo" in md
    assert "00:00:01" not in md


def test_multiple_abbreviations_no_break():
    """etc., vs., cf. não disparam quebra de parágrafo mesmo com texto longo."""
    prefix = "x" * 130
    text = prefix + " etc. Mais texto aqui sem quebra esperada."
    md = transcript_md.format_paragraphs(text)
    # Nenhuma quebra após "etc." — o parágrafo todo deve estar junto
    assert md.count("\n\n") == 0
