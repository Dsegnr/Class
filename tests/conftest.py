# Isolated test fixtures only; never production credentials.
import os
os.environ.setdefault("CLASS_STUDENT_PASSWORD", "local-test-fixture-password")
