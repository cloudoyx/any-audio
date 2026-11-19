# -*- coding: utf-8 -*-
"""Device resolution: auto/cuda only upgrade to cuda when CUDA provider exists.

Guards the settings-page promise: after installing the GPU component, "auto"
and "cuda" both use it; without it everything runs CPU. Each branch injects a
fake onnxruntime so the test needs no GPU and no real inference library.
"""
import os
import sys
import types
import unittest

ENGINE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "engine")
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)


def fake_ort(providers):
    mod = types.ModuleType("onnxruntime")
    mod.get_available_providers = lambda: list(providers)
    return mod


class FakeOrtCase(unittest.TestCase):
    def setUp(self):
        self._real_ort = sys.modules.get("onnxruntime")
        self._real_stdout = sys.stdout

    def tearDown(self):
        # worker.py redirects sys.stdout to sys.stderr at import time; restore it.
        sys.stdout = self._real_stdout
        if self._real_ort is None:
            sys.modules.pop("onnxruntime", None)
        else:
            sys.modules["onnxruntime"] = self._real_ort

    def use(self, providers):
        sys.modules["onnxruntime"] = fake_ort(providers)

    def test_cpu_request_never_upgrades_even_with_cuda(self):
        self.use(["CUDAExecutionProvider", "CPUExecutionProvider"])
        import worker
        self.assertEqual(worker.prepare_device("cpu"), "cpu")
        self.assertEqual(worker.prepare_device("garbage"), "cpu")

    def test_auto_upgrades_to_cuda_when_available(self):
        self.use(["CUDAExecutionProvider", "CPUExecutionProvider"])
        import worker
        self.assertEqual(worker.prepare_device("auto"), "cuda")
        self.assertEqual(worker.prepare_device("cuda"), "cuda")

    def test_auto_stays_cpu_without_cuda_provider(self):
        self.use(["CPUExecutionProvider"])
        import worker
        self.assertEqual(worker.prepare_device("auto"), "cpu")
        self.assertEqual(worker.prepare_device("cuda"), "cpu")

    def test_auto_stays_cpu_when_onnxruntime_missing(self):
        sys.modules["onnxruntime"] = None  # `import onnxruntime` raises ImportError
        import worker
        self.assertEqual(worker.prepare_device("auto"), "cpu")


if __name__ == "__main__":
    unittest.main(verbosity=2)
