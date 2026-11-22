import torch
from torch import nn
from core import INPUT_DIM
class PetMLP(nn.Module):
    def __init__(self):
        super().__init__()
        self.net=nn.Sequential(nn.Linear(INPUT_DIM,64),nn.ReLU(),nn.Linear(64,32),
                               nn.ReLU(),nn.Linear(32,16),nn.ReLU(),nn.Linear(16,1))
    def forward(self,x):
        return self.net(x).squeeze(-1)
